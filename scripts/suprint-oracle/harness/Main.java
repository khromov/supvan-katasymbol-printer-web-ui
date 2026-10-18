package harness;

import android.graphics.Bitmap;
import com.fhit.app_iprinter.communication.bluetooth.BLEUtils;
import com.fhit.app_iprinter.communication.bluetooth.BluetoothUtils;
import com.fhit.app_iprinter.communication.print.G15Print;
import com.fhit.app_iprinter.communication.print.T15Print;
import com.fhit.app_iprinter.dal.models.PrintPageData;
import com.fhit.app_iprinter.dal.models.PrinterStateInfo;
import com.fhit.app_iprinter.globalsingleton.PrintManager;
import com.fhit.app_iprinter.utils.size.DensityUtil;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.file.*;
import java.util.*;

/** Usage: Main <scenario dir>: runs every *.txt scenario and writes <name>.out next to it. */
public class Main {
    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x & 0xff)); return s.toString(); }
    static byte[] unhex(String h) { byte[] b = new byte[h.length() / 2]; for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16); return b; }

    public static void main(String[] args) throws Exception {
        File dir = new File(args[0]);
        File[] files = dir.listFiles((d, n) -> n.endsWith(".txt"));
        Arrays.sort(files);
        int failed = 0;
        for (File f : files) {
            try { run(f); } catch (Throwable t) { failed++; System.out.println(f.getName() + ": FAILED " + t); t.printStackTrace(); }
        }
        System.exit(failed);
    }

    static void run(File f) throws Exception {
        Map<String, String> kv = new HashMap<>();
        List<Bitmap> pages = new ArrayList<>();
        for (String line : Files.readAllLines(f.toPath())) {
            if (line.isEmpty()) continue;
            String[] p = line.split(" ", 2);
            if (p[0].equals("page")) {
                String[] q = p[1].split(" ");
                int w = Integer.parseInt(q[0]), h = Integer.parseInt(q[1]);
                Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                String bits = q[2];
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) b.setPixel(x, y, bits.charAt(y * w + x) == '1' ? 0xff000000 : 0xffffffff);
                pages.add(b);
            } else kv.put(p[0], p.length > 1 ? p[1] : "");
        }
        Emu emu = new Emu();
        emu.name = kv.getOrDefault("name", "T0126E2507010001");
        PrintManager.device.setBluetoothName(emu.name);
        if (kv.containsKey("battery")) emu.batteryMv = Integer.parseInt(kv.get("battery"));
        if (kv.containsKey("extra")) { String[] e = kv.get("extra").split(","); for (int i = 0; i < 4; i++) emu.extra[i] = Integer.parseInt(e[i]); }
        if (kv.containsKey("material")) emu.material = unhex(kv.get("material"));
        if (kv.containsKey("dpi")) emu.dpi = Integer.parseInt(kv.get("dpi"));
        StringBuilder out = new StringBuilder();
        String mode = kv.getOrDefault("mode", "print");
        if (kv.getOrDefault("printer", "t15").equals("e11")) {
            runE11(kv, pages, emu, mode, out);
            write(f, out, emu);
            return;
        }
        PrintManager.device.setPrinterType(15);
        T15Print t = new T15Print();
        t.bluetoothUtils = new BluetoothUtils(emu);
        if (mode.equals("print")) {
            if (kv.containsKey("paperGap")) { Field g = T15Print.class.getDeclaredField("paperGap"); g.setAccessible(true); g.setInt(t, Integer.parseInt(kv.get("paperGap"))); }
            PrintPageData pd = new PrintPageData();
            pd.getPrintBitmap().addAll(pages);
            int length = Integer.parseInt(kv.get("length"));
            pd.setCopy(Integer.parseInt(kv.getOrDefault("copies", "1")));
            pd.setRepeat(1);
            pd.setOneByOne(true);
            pd.setWidth(length);
            pd.setAuto(false);
            List<PrintPageData> list = new ArrayList<>();
            list.add(pd);
            boolean ok = t.doPrint(false, Float.parseFloat(kv.getOrDefault("height", "12")), length, 0, 0, 0, 0, 15,
                Integer.parseInt(kv.getOrDefault("density", "4")), Integer.parseInt(kv.getOrDefault("cut", "0")), 420f,
                Integer.parseInt(kv.getOrDefault("adjustLeft", "0")), Integer.parseInt(kv.getOrDefault("adjustTop", "0")), false, 0,
                kv.getOrDefault("dieCut", "0").equals("1"), Integer.parseInt(kv.getOrDefault("threshold", "204")),
                Integer.parseInt(kv.getOrDefault("outPaper", "0")), 0, 2, 1, list);
            out.append("RESULT ").append(ok).append(' ').append(t.printError).append('\n');
        } else if (mode.equals("media")) {
            com.fhit.app_iprinter.dal.models.Unverified u = t.getMaterial();
            out.append("MEDIA uuid=" + u.getUuid() + " code=" + u.getCode() + " sn=" + u.getSn() + " type=" + u.getType() + " height=" + u.getHeight() + " width=" + u.getWidth() + " remind=" + u.getRemind() + " time=" + u.getTime()).append(" gap=").append(getInt(t, "paperGap")).append('\n');
        } else if (mode.equals("state")) {
            PrinterStateInfo info = new PrinterStateInfo();
            t.getState(info);
            out.append("STATE msg=").append(info.Message).append(" canPrint=").append(info.IsCanPrint).append(" tip=").append(info.IsNeedTip)
                .append(" real=").append(info.IsReal).append(" charged=").append(info.IsCharged).append(" battery=").append(info.BatteryVal).append('\n');
        }
        write(f, out, emu);
    }

    /**
     * The E11 (printer type 3601, printing process 4): G15Print over BLE, called like SUPRINT's
     * EditTemplateActivity does. Before the job the editor reads the tape (getMaterial), sends BLT
     * control (0x37) and the print position doubled (0x38 / 0x39). A tape the printer doesn't
     * recognise only brings up a dialog whose "Continue printing" prints the same way. The pages
     * come at the label's full length, 88 rows tall; the editor's paint area is narrower by the app's
     * own DensityUtil margin, centred, and that margin halved goes to doPrint.
     */
    static void runE11(Map<String, String> kv, List<Bitmap> pages, Emu emu, String mode, StringBuilder out) throws Exception {
        PrintManager.device.setPrinterType(3601);
        PrintManager.device.setPrintingProcess(4);
        G15Print g = new G15Print();
        g.bleUtils = new BLEUtils(emu);
        g.setPrintChannel(g.BLE_BLUETOOTH);
        if (mode.equals("print")) {
            int paperType = Integer.parseInt(kv.getOrDefault("paperType", "1"));
            int length = Integer.parseInt(kv.get("length"));
            // EditTemplateActivity.setPaintWidth / sfPrint: margin r4 in dots off the paint view, r38 / 2 to doPrint.
            int margin = (int) DensityUtil.getPaintViewMarginBetweenValue(length, 0f, paperType, 1, 0);
            int cut = (int) DensityUtil.mmTpx(margin);
            List<Bitmap> paint = new ArrayList<>();
            for (Bitmap p : pages) {
                int w = p.getWidth() - cut, h = p.getHeight();
                Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) b.setPixel(x, y, p.getPixel(x + cut / 2, y));
                paint.add(b);
            }
            out.append("PAINT margin=").append(margin).append(" dots=").append(cut).append('\n');
            g.getMaterial();
            g.setBltControl();
            g.writeLeftRight(Integer.parseInt(kv.getOrDefault("shiftH", "0")) * 2, paperType);
            g.writeTopBottom(Integer.parseInt(kv.getOrDefault("shiftV", "0")) * 2);
            PrintPageData pd = new PrintPageData();
            pd.getPrintBitmap().addAll(paint);
            pd.setCopy(Integer.parseInt(kv.getOrDefault("copies", "1")));
            pd.setRepeat(1);
            pd.setOneByOne(true);
            pd.setWidth(length);
            pd.setAuto(false);
            List<PrintPageData> list = new ArrayList<>();
            list.add(pd);
            // Cut type 1 (the default halfCutting) becomes Cut 0; first cut is the setting (0) minus 1.
            boolean ok = g.doPrint(false, Float.parseFloat(kv.getOrDefault("height", "12")), length, 0, 0, 0, 1, 3601,
                Integer.parseInt(kv.getOrDefault("density", "4")), 1, 420f, 0, 0, false, -1, false, 204, 0, paperType,
                margin / 2, 1, list);
            out.append("RESULT ").append(ok).append(' ').append(g.printError).append('\n');
        } else if (mode.equals("media")) {
            com.fhit.app_iprinter.dal.models.Unverified u = g.getMaterial();
            Field gap = G15Print.class.getDeclaredField("paperGap");
            gap.setAccessible(true);
            out.append("MEDIA uuid=" + u.getUuid() + " code=" + u.getCode() + " sn=" + u.getSn() + " type=" + u.getType() + " height=" + u.getHeight() + " width=" + u.getWidth()).append(" gap=").append(gap.getInt(g)).append('\n');
        } else if (mode.equals("state")) {
            PrinterStateInfo info = new PrinterStateInfo();
            g.getE11State(info);
            out.append("STATE msg=").append(info.Message).append(" canPrint=").append(info.IsCanPrint).append(" tip=").append(info.IsNeedTip)
                .append(" real=").append(info.IsReal).append(" charged=").append(info.IsCharged).append(" battery=").append(info.BatteryVal).append('\n');
        }
    }

    static void write(File f, StringBuilder out, Emu emu) throws IOException {
        for (String e : emu.events) out.append("E ").append(e).append('\n');
        for (byte[] w : emu.writes) out.append("W ").append(hex(w)).append('\n');
        for (byte[] z : emu.streams) out.append("Z ").append(hex(z)).append('\n');
        for (byte[] b : emu.buffers) out.append("B ").append(hex(b)).append('\n');
        for (byte[] l : emu.encoded) out.append("L ").append(hex(l)).append('\n');
        Files.write(Paths.get(f.getPath().replaceAll("\\.txt$", ".out")), out.toString().getBytes());
        System.out.println(f.getName() + ": " + out.toString().split("\n")[0] + " writes=" + emu.writes.size() + " buffers=" + emu.buffers.size());
    }

    static int getInt(Object o, String name) throws Exception { Field g = T15Print.class.getDeclaredField(name); g.setAccessible(true); return g.getInt(o); }
}
