package android.graphics;
/** Minimal stand-in: ARGB int pixels, initially transparent (0) like Android. */
public class Bitmap {
    public enum Config { ARGB_8888 }
    private final int w, h; private final int[] px; private final Config cfg;
    private Bitmap(int w, int h, Config c) { this.w = w; this.h = h; this.cfg = c; this.px = new int[w * h]; }
    public static Bitmap createBitmap(int w, int h, Config c) { return new Bitmap(w, h, c); }
    public int getWidth() { return w; }
    public int getHeight() { return h; }
    public Config getConfig() { return cfg; }
    public boolean isRecycled() { return false; }
    public int getPixel(int x, int y) { if (x < 0 || y < 0 || x >= w || y >= h) throw new IllegalArgumentException("x/y out of range"); return px[y * w + x]; }
    public void setPixel(int x, int y, int c) { px[y * w + x] = c; }
    public void setPixels(int[] pixels, int offset, int stride, int x, int y, int width, int height) {
        for (int r = 0; r < height; r++) for (int c = 0; c < width; c++) px[(y + r) * w + (x + c)] = pixels[offset + r * stride + c];
    }
}
