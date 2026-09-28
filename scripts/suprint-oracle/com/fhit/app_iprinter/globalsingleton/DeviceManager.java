package com.fhit.app_iprinter.globalsingleton;
/** Answers for printer type 15 (T10/E10 series), as the real DeviceManager does. */
public class DeviceManager {
    public static DeviceManager getInstance() { return new DeviceManager(); }
    public boolean t10CompatibleThirdPartyConsumablesPrinter(String s) { return false; }
    public boolean isE11Device(int i) { return i == 3601; }
    public boolean isE12Device(int i) { return i == 3602; }
    public boolean is10_16SeriesDevice(int i) { return i == 15; }
    public boolean is7_11_15SeriesDevice(int i) { return false; }
    public boolean is7_15SeriesDevice(int i) { return false; }
    public boolean is80SeriesDevice(int i) { return false; }
    public boolean isBPSeriesDevice(int i) { return false; }
    public boolean isG15MaxDevice(int i) { return false; }
    public boolean isHP220Device(int i) { return false; }
    public boolean isLPSeriesDevice(int i) { return false; }
    public boolean isMP50MaxDevice(int i) { return false; }
    public boolean isMP50SeriesDevice(int i) { return false; }
    public boolean isMP80SeriesDevice(int i) { return false; }
    public boolean isT50MaxDevice(int i) { return false; }
    public boolean isT50PlusSeriesDevice(int i) { return false; }
    public boolean isT50_A55SeriesDevice(int i) { return false; }
    public boolean isT80MaxDevice(int i) { return false; }
    public boolean isTPSeriesDevice(int i) { return false; }
}
