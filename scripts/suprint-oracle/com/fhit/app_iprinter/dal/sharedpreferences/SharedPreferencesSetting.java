package com.fhit.app_iprinter.dal.sharedpreferences;
public class SharedPreferencesSetting {
    public static String CONSUMABLE_SN = "consumable_sn";
    public static String getString(String k) { return ""; }
    public static String getCustomUuid(String k) { return ""; }
    public static int getNotClearCacheInt(String k, int d) { return d; }
    public static int getInt(String k, int d) { return d; }
    public static int getLanguageType(String k, int d) { return d; }
    public static void set(String k, String v) {}
    public static void set(String k, int v) {}
}
