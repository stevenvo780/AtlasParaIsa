// Fresh process after own writer's SIGKILL; real Store.load + independent SQL.
import { Store } from '../src/server/store.js';import { readManifest,stable } from '../src/server/c10-process-host.js';
const [path,cookie]=process.argv.slice(2);const store=new Store(path);
try { const loaded=store.load();process.send?.({cookie,pid:process.pid,slot:loaded?.slot??null,tick:loaded?.world.tick??null,
 componentFrontier:readManifest(path),worldLoaded:!!loaded}); }finally{store.close();process.disconnect?.();}
