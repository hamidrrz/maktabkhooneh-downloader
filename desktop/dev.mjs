import { spawn } from 'node:child_process';
import electron from 'electron';

const env={...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['.',...process.argv.slice(2)],{env,stdio:'inherit'});
child.on('exit',code=>{process.exitCode=code ?? 1;});
child.on('error',()=>{console.error('Could not launch Electron. Run npm install first.');process.exitCode=1;});
