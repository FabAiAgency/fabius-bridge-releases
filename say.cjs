// say.cjs — post one message into the bot's channel AS the bot.
//   node say.cjs "text"
// Reads config.json from its own folder (works in the pack and in ~/.fabius/<bot>/).
// Prints exactly one of: posted | HTTP <code> | error <short reason> | config unreadable
// The key is read inside this process and never printed.
const fs = require('fs');
const path = require('path');

let c;
try { c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
catch { console.log('config unreadable'); process.exit(0); }

const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.log('usage: node say.cjs "message"'); process.exit(0); }
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

fetch(`${c.hq}/json/2/discuss.channel/message_post`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `bearer ${c.apiKey}` },
  body: JSON.stringify({
    ids: [c.channelId], body: `<p>${esc(text)}</p>`,
    message_type: 'comment', subtype_xmlid: 'mail.mt_comment', body_is_html: true,
  }),
})
  .then((r) => console.log(r.ok ? 'posted' : `HTTP ${r.status}`))
  .catch((e) => console.log(`error ${String(e.message).slice(0, 80)}`));
