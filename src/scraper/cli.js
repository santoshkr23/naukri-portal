require('dotenv').config();
const { runAll } = require('./index');
runAll('cli').then(r => { console.log(r); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
