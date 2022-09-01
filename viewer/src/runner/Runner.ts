import * as c2 from "cache2";
import { CacheProvider } from "cache2";
import * as _ from "lodash";
import { setCacheShare } from "../common/CacheShare";
import { ClearConsole, IRunnerPrivate, Log, LogLevel, ScriptResponse } from "../common/Runner";
import { ServiceClient } from "../common/ServiceClient";
import { ServiceServer } from "../common/ServiceServer";
import { serialize } from "../common/uiobject";
import * as ctx from "../context";

interface System {
	register(dependencies: string[], declare: System.DeclareFn): void;
	register(name: string, dependencies: string[], declare: System.DeclareFn): void;
}
namespace System {
	export type ImportFn = <T extends Module>(moduleId: string, parentUrl?: string) => Promise<T>;

	export type DeclareFn = (_export: ExportFn, _context: Context) => Declare;
	export interface Declare {
		setters?: SetterFn[];
		execute?(): any;
	}
	export type SetterFn = (moduleValue: Module) => any;
	export type ExecuteFn = () => any;

	export interface ExportFn {
		(exportName: string, value: any): void;
		(exports: object): void;
	}

	export interface Context {
		import: ImportFn;
		meta: {
			url: string;
		};
	}

	export interface Module {
		default?: any;
		[exportName: string]: any;
	}
}

class ScriptRunner {
	stopped = false;
	console: Console;
	private context: object;

	constructor(private readonly port: MessagePort) {
		const logger = (level: LogLevel) => {
			return (...args: any[]) => {
				if (this.stopped) {
					self.console.log("(previous)", ...args);
					return;
				}
				self.console.log(...args);
				let [uidata, transfer] = serialize(args);
				this.respond<Log>({
					type: "log",
					level,
					args: uidata,
				}, transfer);
			};
		};

		let console = this.console = {
			...self.console,
			log: logger("info"),
			info: logger("info"),
			warn: logger("warning"),
			debug: logger("debug"),
			error: logger("error"),
			trace: logger("trace"),
			assert(assertion, ...args: any[]) {
				if (!assertion) {
					this.error(...args);
				}
			},
			clear: () => {
				if (this.stopped) {
					return;
				}
				this.respond<ClearConsole>({
					type: "clearconsole",
				});
			},
			dir(obj) {
				this.info(obj);
			},
			dirxml(obj) {
				this.info(obj);
			},
		};

		let system: System = {
			register(...args: [string, string[], System.DeclareFn] | [string[], System.DeclareFn]) {
				if (typeof args[0] === "string") {
					// @ts-ignore
					[, ...args] = args;
				}
				let [deps, declare] = <[string[], System.DeclareFn]> args;

				let iport: System.ImportFn = name => {
					switch (name) {
						case "cache2":
							return import("cache2");
						case "viewer/context":
							return import("../context");
						case "lodash":
							return import("lodash");
						default:
							return import(name);
					}
				};

				let { setters, execute } = declare(() => {/*noop*/}, { import: iport, meta: { url: "/run.js" } });

				if (deps && setters) {
					return (async () => {
						try {
							let resolvedDeps = await Promise.all(deps.map(name => iport(name)));
							resolvedDeps.forEach((v, i) => setters![i](v));
							if (execute) {
								return await execute();
							}
						} catch (e) {
							console.error(e);
						}
					})();
				}
			},
		};

		this.context = {
			console,
			System: system,
			$_typed_: c2.Typed._,
			_,
		};
	}

	async evaluate(source: string): Promise<unknown> {
		// @ts-ignore
		let keys: (keyof typeof this.context)[] = Object.keys(this.context);
		let values = keys.map(k => this.context[k]);

		return await new Function(...keys, source).bind(self, ...values)();
	}

	respond<T extends ScriptResponse>(v: T, transferables: Transferable[] = []) {
		try {
			this.port.postMessage(v, transferables);
		} catch (e) {
			console.error(e);
		}
	}

	stop() {
		this.stopped = true;
	}
}

let activeScript: ScriptRunner | undefined;

let types = {
	item: c2.Item,
	hitsplat: c2.Hitsplat,
};

new ServiceServer<IRunnerPrivate>(self as DedicatedWorkerGlobalScope, {
	async prepare(cacheShare) {
		setCacheShare(ServiceClient.create(cacheShare));
	},
	executeScript(text, port) {
		activeScript?.stop();
		let script = activeScript = new ScriptRunner(port);
		script.respond<ClearConsole>({
			type: "clearconsole",
			silent: true,
		});
		return script.evaluate(text)
			.catch(e => script.console.error(e))
			.then(value => {
				if (script.stopped) {
					return;
				}

				if (value) {
					let [uidata, trans] = serialize([value]);
					script.respond<Log>({
						type: "log",
						level: "done",
						args: uidata,
					}, trans);
				}
			});
	},
	async lookup(type, filter) {
		let typ: {
			decode: (c: Promise<CacheProvider>, id: number) => any;
			all(c: Promise<CacheProvider>): Promise<any[]>;
		} = types[type];
		let v: any[];
		if (/^[0-9, -]+$/.test(filter)) {
			v = await Promise.all(
				filter.split(",")
					.map(v => v.trim())
					.filter(v => v)
					.flatMap(v => {
						let d = v.split("-");
						if (d.length == 1) {
							return [~~d[0]];
						}
						return _.range(~~d[0], ~~d[1] + 1);
					})
					.map(id => typ.decode(ctx.cache, id)),
			);
		} else {
			let re = new RegExp(filter, "iu");
			v = (await typ.all(ctx.cache))
				.filter(v => re.test(v?.name));
		}

		if (v.length == 1) {
			return ServiceServer.return(...serialize(v[0]));
		}

		return ServiceServer.return(...serialize(v));
	},
});

postMessage({ type: "ready" });
