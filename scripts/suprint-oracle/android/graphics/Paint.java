package android.graphics;
public class Paint {
    public enum Style { STROKE, FILL }
    public static class FontMetrics { public float top, bottom, ascent, descent; }
    public void setColor(int c) {}
    public void setStrokeWidth(float w) {}
    public void setStyle(Style s) {}
    public void setTextSize(float s) {}
    public float measureText(String s) { return 0; }
    public void getTextBounds(String s, int a, int b, Rect r) {}
    public FontMetrics getFontMetrics() { return new FontMetrics(); }
}
