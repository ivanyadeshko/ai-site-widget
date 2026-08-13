// Стабильный /w.js: сниппет у клиента на сайте ВЕЧЕН, а бандл обязан катиться
// без дрейфа кэша. Шим короткий, кэш 60с; хэшированный бандл — immutable.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const hashed = readdirSync(dist).find((f) => /^w\.[^.]+\.js$/.test(f));
if (!hashed) { console.error('в dist нет w.<hash>.js — сначала vite build'); process.exit(1); }

writeFileSync(join(dist, 'w.js'), `(function(){
var me=document.currentScript||document.querySelector('script[data-widget]');
if(!me)return;var t=me.getAttribute('data-widget');if(!t)return;
var base=me.getAttribute('data-host')||new URL('.',me.src).href;
(window.AskiWidgetQueue=window.AskiWidgetQueue||[]).push({token:t,base:base});
var s=document.createElement('script');s.async=true;s.src=new URL('${hashed}',me.src).href;
(document.head||document.documentElement).appendChild(s);})();`);
console.log(`шим /w.js указывает на ${hashed}`);
