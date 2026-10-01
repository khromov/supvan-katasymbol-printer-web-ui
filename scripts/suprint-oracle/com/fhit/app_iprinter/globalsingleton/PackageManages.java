package com.fhit.app_iprinter.globalsingleton;
public class PackageManages {
    public static PackageManages getInstance() { return new PackageManages(); }
    public static String getPackageName() { return "com.supvan.IPrinterEn"; }
    public boolean isKata() { return false; }
    public boolean isSuprint() { return true; }
}
