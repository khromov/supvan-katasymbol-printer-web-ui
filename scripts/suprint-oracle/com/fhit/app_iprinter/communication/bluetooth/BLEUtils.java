package com.fhit.app_iprinter.communication.bluetooth;

import harness.Emu;

/**
 * Stand-in for the BLE link: every write goes to the emulator, and a reply it makes arrives at once,
 * as the notification would (onCharacteristicChanged: current value, then the result command [7]).
 */
public class BLEUtils {
    private final Emu emu;
    private byte request, result;
    private byte[] current;
    public BLEUtils(Emu emu) { this.emu = emu; }
    public void write(byte[] b) {
        emu.clearReplies();
        emu.receive(b.clone());
        byte[] r = emu.takeReply();
        if (r == null) return;
        current = r;
        if (r.length > 7) result = r[7];
    }
    public void writeNoResponse(byte[] b) { write(b); }
    public byte getRequestCommand() { return request; }
    public void setRequestCommand(byte b) { request = b; }
    public byte getResultCommand() { return result; }
    public void setResultCommand(byte b) { result = b; }
    public byte[] getCurrentValue() { return current; }
    public void setCurrentValue(byte[] b) { current = b; }
}
