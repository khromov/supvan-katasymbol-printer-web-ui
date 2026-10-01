package com.fhit.app_iprinter.communication.bluetooth;

import harness.Emu;

/** Stand-in for the classic SPP link: ConnectedThread.write clears pending input, writes, sleeps 10 ms; read takes one reply. */
public class BluetoothUtils {
    private final Emu emu;
    public BluetoothUtils(Emu emu) { this.emu = emu; }
    public boolean write(byte[] b) { return write(b, 0, b.length); }
    public boolean write(byte[] b, int off, int len) {
        emu.clearReplies();
        emu.receive(java.util.Arrays.copyOfRange(b, off, off + len));
        try { Thread.sleep(10L); } catch (InterruptedException e) {}
        return true;
    }
    public boolean read(byte[] out) {
        byte[] r = emu.takeReply();
        if (r == null) return false;
        System.arraycopy(r, 0, out, 0, Math.min(r.length, out.length));
        return true;
    }
}
