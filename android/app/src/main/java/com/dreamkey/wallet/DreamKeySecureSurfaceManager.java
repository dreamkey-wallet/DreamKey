package com.dreamkey.wallet;

import android.content.Context;
import android.view.View;
import android.view.WindowManager;
import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;

/** Protects RN Modal's separate Dialog window, which does not inherit Activity flags. */
public final class DreamKeySecureSurfaceManager extends SimpleViewManager<View> {
  @Override public String getName() { return "DreamKeySecureSurface"; }

  @Override protected View createViewInstance(ThemedReactContext context) {
    return new View(context) {
      @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (BuildConfig.DEBUG) return;
        View root = getRootView();
        if (!(root.getLayoutParams() instanceof WindowManager.LayoutParams)) {
          root.setVisibility(View.INVISIBLE);
          return;
        }
        WindowManager.LayoutParams params = (WindowManager.LayoutParams) root.getLayoutParams();
        params.flags |= WindowManager.LayoutParams.FLAG_SECURE;
        try {
          WindowManager manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
          manager.updateViewLayout(root, params);
        } catch (RuntimeException error) {
          // Never display sensitive content if this window cannot be protected.
          root.setVisibility(View.INVISIBLE);
        }
      }
    };
  }
}
