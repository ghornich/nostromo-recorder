import path from 'path';
import minimist from 'minimist';
import RecorderServer from './recorder-server.js';
const args = minimist(process.argv.slice(2));

async function run() {
    const DEFAULT_REC_CFG_FILE = 'nostromo.record.conf.js';
    const configPath = args.config || args.c || DEFAULT_REC_CFG_FILE;
    const fileConf = {};

    // try {
    //     const absConfigPath = path.resolve(configPath);
    //     process.chdir(path.dirname(absConfigPath));
    //     const configFn = require(absConfigPath);

    //     fileConf = await configFn();
    // }
    // catch (e) {
    //     if (e.code === 'ENOENT') {
    //         console.log('WARNING: recorder config file not found. Using default settings.');
    //     }
    //     else {
    //         console.log(e.message);
    //         process.exit(1);
    //     }
    // }

    const defaultConf = {
        recorderAppPort: 7700,
        logLevel: 'warn',
    };

    const conf = { ...defaultConf, ...fileConf, ...args };
    const recServer = new RecorderServer(conf);

    // no await
    recServer.start();

    process.on('SIGINT', () => {
        console.log('Stopping...');
        recServer.stop();
    });
}

run();
