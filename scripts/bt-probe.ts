// Read-only Bluetooth probe: device name, status (incl. battery) and loaded label.
import { NodeSerialTransport } from './node-serial.ts';
import { T5080BtDriver } from '../src/lib/printer/families/t5080-bt.ts';

const t = await NodeSerialTransport.open(process.argv[2]);
console.log('opened', t.name);
const d = new T5080BtDriver(t);
d.channel.debug = process.env.DEBUG === '1';
try {
	await d.handshake();
	console.log('device name:', await d.readDeviceName().catch((e) => `(failed: ${e.message})`));
	console.log('status:', { ...(await d.getStatus()), raw: undefined });
	console.log('media:', { ...(await d.readMedia()), raw: undefined });
} finally {
	await t.close();
}
