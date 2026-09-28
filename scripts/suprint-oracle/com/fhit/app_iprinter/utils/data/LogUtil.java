package com.fhit.app_iprinter.utils.data;
public class LogUtil { public static void e(String s) { System.err.println("LogUtil.e " + s); } public static void e(String s, Throwable t) { e(s); } }
