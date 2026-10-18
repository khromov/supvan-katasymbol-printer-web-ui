package com.fhit.app_iprinter.globalsingleton;
import com.fhit.app_iprinter.dal.models.SystemTemplate;
/** G15Print only reads the current template's ID (the real class pulls in the UI). */
public class TemplateManager { public static SystemTemplate systemTemplate = new SystemTemplate(); }
