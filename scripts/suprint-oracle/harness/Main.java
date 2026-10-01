package harness;

import android.graphics.Bitmap;
import com.fhit.app_iprinter.communication.bluetooth.BluetoothUtils;
import com.fhit.app_iprinter.communication.print.T15Print;
import com.fhit.app_iprinter.dal.models.PrintPageData;
import com.fhit.app_iprinter.dal.models.PrinterStateInfo;
import com.fhit.app_iprinter.globalsingleton.PrintManager;
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
        T15Print t = new T15Print();
        t.bluetoothUtils = new BluetoothUtils(emu);
        StringBuilder out = new StringBuilder();
        String mode = kv.getOrDefault("mode", "print");
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
