package com.fhit.app_iprinter.globalsingleton;
/**
 * Answers for printer types 15 (T10/E10 series) and 3601 (E11), as the real DeviceManager does
 * (is10_16SeriesDevice covers both: isT15_16_11SeriesDevice includes the E11). Includes what
 * DensityUtil.mmTpx and getPaintViewMarginBetweenValue ask.
 */
public class DeviceManager {
    public static DeviceManager getInstance() { return new DeviceManager(); }
    public boolean t10CompatibleThirdPartyConsumablesPrinter(String s) { return false; }
    public boolean isE11Device(int i) { return i == 3601; }
    public boolean isE12Device(int i) { return i == 3602; }
    public boolean is10_16SeriesDevice(int i) { return i == 15 || i == 3601; }
    public boolean is7SeriesDevice(int i) { return false; }
    public boolean is7_11_15SeriesDevice(int i) { return false; }
    public boolean is7_15SeriesDevice(int i) { return false; }
    public boolean is80SeriesDevice(int i) { return false; }
    public boolean isBP337Device(int i) { return false; }
    public boolean isBP367Device(int i) { return false; }
    public boolean isBPSeriesDevice(int i) { return false; }
    public boolean isFullCutMachine(int i) { return false; }
    public boolean isG15MaxDevice(int i) { return false; }
    public boolean isG15MiniDevice(int i) { return false; }
    public boolean isG21PlusDevice(int i) { return false; }
    public boolean isG21ProDevice(int i) { return false; }
    public boolean isG25Device(int i) { return false; }
    public boolean isG25PlusDevice(int i) { return false; }
    public boolean isHP220Device(int i) { return false; }
    public boolean isLPSeriesDevice(int i) { return false; }
    public boolean isMP50Device(int i) { return false; }
    public boolean isMP50MaxDevice(int i) { return false; }
    public boolean isMP50ProDevice(int i) { return false; }
    public boolean isMP50SeriesDevice(int i) { return false; }
    public boolean isMP80Device(int i) { return false; }
    public boolean isMP80ProDevice(int i) { return false; }
    public boolean isMP80SeriesDevice(int i) { return false; }
    public boolean isP60Device(int i) { return false; }
    public boolean isP66Device(int i) { return false; }
    public boolean isP70Device(int i) { return false; }
    public boolean isP76Device(int i) { return false; }
    public boolean isT50MaxDevice(int i) { return false; }
    public boolean isT50PlusSeriesDevice(int i) { return false; }
    public boolean isT50Plus_Device(int i) { return false; }
    public boolean isT50_A55SeriesDevice(int i) { return false; }
    public boolean isT80MaxDevice(int i) { return false; }
    public boolean isT80Pro_Device(int i) { return false; }
    public boolean isTL8Device(int i) { return false; }
    public boolean isTP20Device(int i) { return false; }
    public boolean isTP2000SeriesDevice(int i) { return false; }
    public boolean isTP50Device(int i) { return false; }
    public boolean isTP56Device(int i) { return false; }
    public boolean isTP78SeriesDevice(int i) { return false; }
    public boolean isTP8086ADevice(int i) { return false; }
    public boolean isTPSeriesDevice(int i) { return false; }
}
