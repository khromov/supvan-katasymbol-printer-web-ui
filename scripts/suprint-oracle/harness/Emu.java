package harness;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Deterministic E10 stand-in. State only changes on commands, never on time, so the app's write
 * stream is reproducible: never busy, START sets printing, the buffer never reports full, and the
 * BUF_FULL that commits a buffer with PrtEnd clears printing.
 */
public class Emu {
    public final List<byte[]> writes = new ArrayList<>();
    public final List<byte[]> streams = new ArrayList<>();
    public final List<byte[]> buffers = new ArrayList<>();
    /** What the app's own encoder makes of each buffer, i.e. the exact stream it sent. */
    public final List<byte[]> encoded = new ArrayList<>();
    public final List<String> events = new ArrayList<>();
    private final ArrayDeque<byte[]> replies = new ArrayDeque<>();
    private ByteArrayOutputStream pending = new ByteArrayOutputStream();
    private ByteArrayOutputStream stream = new ByteArrayOutputStream();
    private int expectFrames = 0, gotFrames = 0;
    public boolean busy = false, printing = false;
    /** Extra status bits OR-ed into INQUIRY bytes 0..3 (error injection). */
    public int[] extra = {0, 0, 0, 0};
    public int batteryMv = 4000;
    public byte[] material = null;
    public String name = "T0126E2507010001";

    public void clearReplies() { replies.clear(); }
    public byte[] takeReply() { return replies.poll(); }

    public void receive(byte[] b) {
        writes.add(b.clone());
        pending.write(b, 0, b.length);
        byte[] buf = pending.toByteArray();
        int i = 0;
        while (buf.length - i >= 4) {
            if ((buf[i] & 0xff) != 0x7e || (buf[i + 1] & 0xff) != 0x5a) throw new IllegalStateException("bad frame start at " + i);
            int total = (buf[i + 2] & 0xff | (buf[i + 3] & 0xff) << 8) + 4;
            if (buf.length - i < total) break;
            byte[] f = java.util.Arrays.copyOfRange(buf, i, i + total);
            i += total;
            frame(f);
        }
        pending = new ByteArrayOutputStream();
        pending.write(buf, i, buf.length - i);
    }

    private static int sum(byte[] f, int from, int to) { int s = 0; for (int k = from; k < to; k++) s += f[k] & 0xff; return s & 0xffff; }
    private static int u16(byte[] f, int at) { return f[at] & 0xff | (f[at + 1] & 0xff) << 8; }

    private void frame(byte[] f) {
        if (f.length == 512 && (f[5] & 0xff) == 2) { data(f); return; }
        if (sum(f, 10, f.length) != u16(f, 8)) throw new IllegalStateException("bad command checksum");
        int cmd = f[7] & 0xff, a = u16(f, 12), b = f.length >= 16 ? u16(f, 14) : 0;
        events.add(String.format("cmd %02x %d %d", cmd, a, b));
        switch (cmd) {
            case 0x11: reply(cmd, status()); return;
            case 0x13: printing = true; break;
            case 0x14: printing = false; break;
            case 0x5c:
                if (a != 512) throw new IllegalStateException("0x5c block size " + a);
                expectFrames = b; gotFrames = 0; stream = new ByteArrayOutputStream(); break;
            case 0x10: commit(); break;
            case 0x16: { byte[] p = new byte[40]; byte[] n = name.getBytes(); System.arraycopy(n, 0, p, 12, n.length); reply(cmd, p, 18 + n.length); return; }
            case 0x30: if (material != null) { reply(cmd, material); return; } break;
            default: break;
        }
        reply(cmd, new byte[16]);
    }

    private byte[] status() {
        byte[] p = new byte[16];
        p[4] = (byte) (extra[0]);
        p[5] = (byte) ((busy ? 4 : 0) | extra[1]);
        p[6] = (byte) ((printing ? 0x40 : 0) | extra[2]);
        p[7] = (byte) extra[3];
        p[14] = (byte) batteryMv; p[15] = (byte) (batteryMv >> 8);
        return p;
    }

    /** Reply: 7E 5A len 10 01 AA cmd sum(10..end) then payload from [10]. */
    private void reply(int cmd, byte[] payload) { reply(cmd, payload, payload.length + 6); }
    private void reply(int cmd, byte[] payload, int len) {
        byte[] r = new byte[10 + payload.length];
        r[0] = 0x7e; r[1] = 0x5a; r[2] = (byte) len; r[3] = (byte) (len >> 8); r[4] = 0x10; r[5] = 1; r[6] = (byte) 0xaa; r[7] = (byte) cmd;
        System.arraycopy(payload, 0, r, 10, payload.length);
        int s = sum(r, 10, r.length); r[8] = (byte) s; r[9] = (byte) (s >> 8);
        replies.add(r);
    }

    private void data(byte[] f) {
        if ((f[6] & 0xff) != 0xaa || (f[7] & 0xff) != 0xbb) throw new IllegalStateException("bad data frame header");
        if (sum(f, 10, 512) != u16(f, 8)) throw new IllegalStateException("bad data checksum");
        if ((f[10] & 0xff) != gotFrames || (f[11] & 0xff) != expectFrames) throw new IllegalStateException("frame index " + (f[10] & 0xff) + "/" + (f[11] & 0xff));
        stream.write(f, 12, 500);
        gotFrames++;
        reply(0xbb, new byte[16]);
    }

    /** The app's own LzmaDeEncode is dead code and returns nothing, so decode with Python's LZMA-alone decoder. */
    static byte[] decode(byte[] z) {
        try {
            Process p = new ProcessBuilder("python3", "-c",
                "import lzma,sys\nd=lzma.LZMADecompressor(lzma.FORMAT_ALONE)\nsys.stdout.buffer.write(d.decompress(sys.stdin.buffer.read()))").start();
            p.getOutputStream().write(z);
            p.getOutputStream().close();
            byte[] out = p.getInputStream().readAllBytes();
            if (p.waitFor() != 0) throw new IllegalStateException(new String(p.getErrorStream().readAllBytes()));
            return out;
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private void commit() {
        if (gotFrames != expectFrames) throw new IllegalStateException("got " + gotFrames + " of " + expectFrames + " frames");
        byte[] z = stream.toByteArray();
        // The real length is unknown to the printer (BUF_FULL carries 0); the LZMA header's size bounds decoding.
        long size = 0; for (int k = 0; k < 8; k++) size |= (long) (z[5 + k] & 0xff) << (8 * k);
        byte[] raw = decode(z);
        if (raw == null || raw.length != size) throw new IllegalStateException("LZMA stream does not decode: raw=" + (raw == null ? "null" : raw.length) + " size=" + size + " z=" + z.length + " head=" + Main.hex(java.util.Arrays.copyOf(z, 16)));
        streams.add(z);
        buffers.add(raw);
        encoded.add(com.fhit.app_iprinter.communication.print.compression.LzmaUtils.LzmaEncode(raw));
        if ((raw[2] & 0x08) != 0) printing = false;
    }
}
