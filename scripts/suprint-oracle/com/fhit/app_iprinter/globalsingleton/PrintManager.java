package com.fhit.app_iprinter.globalsingleton;
import com.fhit.app_iprinter.communication.device.BaseDevice;
public class PrintManager {
    public static final BaseDevice device = new BaseDevice();
    static { device.setPrinterType(15); }
    public static PrintManager getInstance() { return new PrintManager(); }
    public BaseDevice getBaseDevice() { return device; }
    public boolean isAsyncPrint() { return false; }
    public boolean isPrinterConnected() { return true; }
}
