import { parseArgs } from 'node:util';
import { openStore } from './runtime.mjs';
const {values} = parseArgs({ options: Object.fromEntries(['name','date','kind','url','note','aliases'].map(key => [key, {type:'string'}])) });
if (!values.name || !values.date || !values.kind || !values.url || !values.note) throw new Error('Provide --name --date YYYY-MM-DD --kind origin|occurrence --url --note [--aliases comma,separated]');
const store = openStore();
try { store.addEvidence({...values, aliases: values.aliases?.split(',') || []}); store.refresh(); console.log('Dated evidence saved. The label will apply when this topic has qualifying activity.'); }
finally { store.close(); }
