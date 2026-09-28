package android.graphics;
/** drawBitmap(src, srcRect, dstRect) with nearest-neighbour sampling; opaque pixels replace, transparent ones are skipped. */
public class Canvas {
    private final Bitmap target;
    public Canvas(Bitmap b) { target = b; }
    public void drawBitmap(Bitmap src, Rect s, Rect d, Paint p) {
        int dw = d.right - d.left, dh = d.bottom - d.top, sw = s.right - s.left, sh = s.bottom - s.top;
        if (dw <= 0 || dh <= 0) return;
        for (int y = 0; y < dh; y++) {
            int ty = d.top + y; if (ty < 0 || ty >= target.getHeight()) continue;
            int sy = s.top + (int) (((long) y * sh) / dh);
            for (int x = 0; x < dw; x++) {
                int tx = d.left + x; if (tx < 0 || tx >= target.getWidth()) continue;
                int sx = s.left + (int) (((long) x * sw) / dw);
                int c = src.getPixel(sx, sy);
                if ((c >>> 24) != 0) target.setPixel(tx, ty, c);
            }
        }
    }
    public void drawColor(int c) {}
    public void drawText(String s, float x, float y, Paint p) {}
    public int save() { return 0; }
    public void restore() {}
}
