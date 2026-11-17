import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src/ardia/linux'
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-borderless-frame.patch'
FRAMELESS = PATCHES / 'chromium-linux-frameless-utility-windows.patch'
FRAME = 'chrome/browser/ui/views/frame/'
BROWSER_VIEW = FRAME + 'browser_view.cc'

GLOBALS_157 = '''int (*g_ardia_linux_window_tab_count)(const BrowserWindowInterface*) = nullptr;
bool (*g_ardia_linux_shell_passes_point)(gfx::NativeView child,
                                         const gfx::Point& location) = nullptr;
void (*g_ardia_linux_minimum_size)(const BrowserWindowInterface*,
                                   gfx::Size* minimum) = nullptr;

namespace {

bool ArdiaLinuxBackgroundInstance() {
'''
TITLE_157 = '''  return nullptr;
}

bool BrowserView::ShouldShowWindowTitle() const {
  return WindowFeatureController::From(browser_)->SupportsWindowFeature(
      WindowFeatureController::WindowFeature::kFeatureTitleBar);
}

bool BrowserView::ShouldShowWindowIcon() const {
'''

LAYOUT_CC = [
    (10, r'''#include "ui/gfx/geometry/insets.h"
#include "ui/views/window/frame_view_utils_linux.h"

namespace {

// This is the same thickness as the resize border on ChromeOS.
'''),
    (35, r'''}

gfx::Insets BrowserFrameViewLayoutLinux::GetInputInsets() const {
  bool showing_shadow = delegate_->ShouldDrawRestoredFrameShadow() &&
                        !delegate_->IsFrameCondensed();
  return gfx::Insets(showing_shadow ? kResizeBorder : 0);
'''),
    (46, r'''}

gfx::Insets BrowserFrameViewLayoutLinux::RestoredFrameBorderInsets() const {
  // Unframed mode only has a minimal frame so it is resizable from the borders.
  if (delegate_->GetUnframedModeEnabled()) {
    return gfx::Insets(
'''),
    (74, r'''int BrowserFrameViewLayoutLinux::NonClientExtraTopThickness() const {
  return delegate_->IsTabStripVisible() ? 0 : kExtraTopBorder;
}
'''),
]

LAYOUT_H = [
    (36, r'''  gfx::Insets RestoredFrameEdgeInsets() const override;
  int NonClientExtraTopThickness() const override;

 private:
  raw_ptr<BrowserFrameViewLinux> view_ = nullptr;
};
'''),
]

LAYOUT_NATIVE_CC = [
    (39, r'''
gfx::Insets BrowserFrameViewLayoutLinuxNative::RestoredFrameBorderInsets()
    const {
  // Unframed mode only has a minimal frame to be able to resize it from the
  // borders.
  if (delegate_->GetUnframedModeEnabled()) {
'''),
]

VIEW_CC = [
    (19, r'''#include "ui/views/window/frame_view_utils_linux.h"
#include "ui/views/window/window_button_order_provider.h"

namespace {

// The resize border at the top of the caption area. Only used when frame
'''),
    (70, r'''
void BrowserFrameViewLinux::PaintRestoredFrameBorder(
    gfx::Canvas* canvas) const {
#if BUILDFLAG(IS_LINUX)
  const bool tiled = browser_widget()->tiled();
#else
'''),
    (90, r'''}

bool BrowserFrameViewLinux::ShouldDrawRestoredFrameShadow() const {
  return static_cast<BrowserNativeWidgetAuraLinux*>(
             browser_widget()->browser_native_widget())
      ->ShouldDrawRestoredFrameShadow();
'''),
    (114, r'''}

int BrowserFrameViewLinux::NonClientHitTest(const gfx::Point& point) {
  int frame_component = OpaqueBrowserFrameView::NonClientHitTest(point);
  // Allow resizing at the top of the caption area. This is only done when
  // shadows are not drawn, since the resize area is on the shadows otherwise.
'''),
    (125, r'''}

float BrowserFrameViewLinux::GetRestoredCornerRadiusDip() const {
#if BUILDFLAG(IS_LINUX)
  const bool tiled = browser_widget()->tiled();
#else
'''),
]

VIEW_NATIVE_CC = [
    (11, r'''#include "ui/views/window/frame_background.h"
#include "ui/views/window/frame_view_utils_linux.h"

BrowserFrameViewLinuxNative::BrowserFrameViewLinuxNative(
    BrowserWidget* widget,
    BrowserView* browser_view,
'''),
    (52, r'''}

float BrowserFrameViewLinuxNative::GetRestoredCornerRadiusDip() const {
  return layout_->GetFrameProvider()->GetTopCornerRadiusDip();
}

void BrowserFrameViewLinuxNative::PaintRestoredFrameBorder(
    gfx::Canvas* canvas) const {
  layout_->GetFrameProvider()->PaintWindowFrame(
      canvas, GetLocalBounds(), GetTopAreaHeight(), ShouldPaintAsActive(),
      GetInputInsets());
'''),
]

FRAME_FILES = {
    'browser_frame_view_layout_linux.cc': LAYOUT_CC,
    'browser_frame_view_layout_linux.h': LAYOUT_H,
    'browser_frame_view_layout_linux_native.cc': LAYOUT_NATIVE_CC,
    'browser_frame_view_linux.cc': VIEW_CC,
    'browser_frame_view_linux_native.cc': VIEW_NATIVE_CC,
}


def at_real_lines(fragments):
    lines = []
    for start, text in fragments:
        lines.extend([''] * (start - 1 - len(lines)))
        lines.extend(text.splitlines())
    return '\n'.join(lines) + '\n'


class BorderlessFrameTests(unittest.TestCase):
    def setUp(self):
        self.host = (LINUX / 'ac_linux_host.cc').read_text()

    def contains(self, needle, text):
        self.assertTrue(needle in text, f'missing from the text: {needle!r}')

    def patched(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        self.assertTrue(PATCH.exists(), f'{PATCH.name} is missing')
        with tempfile.TemporaryDirectory(prefix='ardia-borderless-') as directory:
            root = Path(directory)
            view = root / BROWSER_VIEW
            view.parent.mkdir(parents=True)
            view.write_text('\n' * 431 + GLOBALS_157 + '\n' * 3580 + TITLE_157)
            for name, fragments in FRAME_FILES.items():
                (root / FRAME / name).write_text(at_real_lines(fragments))
            for patch, only in ((FRAMELESS, BROWSER_VIEW), (PATCH, None)):
                command = ['git', 'apply', '--whitespace=nowarn']
                if only:
                    command.append(f'--include={only}')
                result = subprocess.run(command + [str(patch)], cwd=directory, capture_output=True, text=True,
                                        timeout=30)
                self.assertEqual(result.returncode, 0, f'{patch.name}: {result.stderr}')
            return {name: (root / FRAME / name).read_text() for name in [*FRAME_FILES, 'browser_view.cc']}

    def test_the_patch_is_linux_only_and_after_the_frameless_patch(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        self.contains(PATCH.name, names)
        at = names.index(PATCH.name)
        self.assertEqual(steps[at], ['chromium', PATCH.name, 'linux'])
        self.assertGreater(at, names.index(FRAMELESS.name))
        self.assertEqual(names.count(PATCH.name), 1)

    def test_the_hook_names_the_hosted_windows(self):
        view = self.patched()['browser_view.cc']
        self.contains('bool (*g_ardia_linux_borderless_frame)(const BrowserWindowInterface*) = nullptr;\n', view)
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view) {\n'
                      '  if (!g_ardia_linux_borderless_frame || !browser_view) {\n    return false;\n  }\n'
                      '  const BrowserWindowInterface* browser = browser_view->browser();\n'
                      '  return browser && (ArdiaLinuxFramelessApp(browser) ||\n'
                      '                     g_ardia_linux_borderless_frame(browser));\n}\n', view)
        self.assertLess(view.index('bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser) {'),
                        view.index('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view) {'))

    def test_the_frame_layout_gives_the_client_the_whole_window(self):
        files = self.patched()
        layout = files['browser_frame_view_layout_linux.cc']
        self.contains('class BrowserView;\n\nbool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', layout)
        self.contains('gfx::Insets BrowserFrameViewLayoutLinux::GetInputInsets() const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', layout)
        self.contains('gfx::Insets BrowserFrameViewLayoutLinux::RestoredFrameBorderInsets() const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', layout)
        self.contains('bool BrowserFrameViewLayoutLinux::ArdiaBorderless() const {\n'
                      '  return view_ && ArdiaLinuxBorderlessFrame(view_->GetBrowserView());\n}\n', layout)
        header = files['browser_frame_view_layout_linux.h']
        self.contains('  int NonClientExtraTopThickness() const override;\n\n'
                      '  bool ArdiaBorderless() const;\n', header)
        self.assertLess(header.index('bool ArdiaBorderless() const;'), header.index(' private:'))
        native = files['browser_frame_view_layout_linux_native.cc']
        self.contains('BrowserFrameViewLayoutLinuxNative::RestoredFrameBorderInsets()\n    const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', native)

    def test_the_frame_view_paints_no_border_shadow_or_corners(self):
        files = self.patched()
        view = files['browser_frame_view_linux.cc']
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', view)
        self.contains('void BrowserFrameViewLinux::PaintRestoredFrameBorder(\n    gfx::Canvas* canvas) const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return;\n  }\n', view)
        self.contains('bool BrowserFrameViewLinux::ShouldDrawRestoredFrameShadow() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return false;\n  }\n', view)
        self.contains('float BrowserFrameViewLinux::GetRestoredCornerRadiusDip() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return 0;\n  }\n', view)
        native = files['browser_frame_view_linux_native.cc']
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', native)
        self.contains('float BrowserFrameViewLinuxNative::GetRestoredCornerRadiusDip() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return 0;\n  }\n', native)
        self.contains('    gfx::Canvas* canvas) const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return;\n  }\n'
                      '  layout_->GetFrameProvider()->PaintWindowFrame(\n', native)

    def test_a_thin_band_along_the_edges_still_resizes_the_window(self):
        view = self.patched()['browser_frame_view_linux.cc']
        hit = view[view.index('int BrowserFrameViewLinux::NonClientHitTest('):]
        hit = hit[:hit.index('float BrowserFrameViewLinux::GetRestoredCornerRadiusDip')]
        self.contains('ArdiaLinuxBorderlessFrame(GetBrowserView()) && !IsFrameCondensed()', hit)
        self.contains('browser_widget()->widget_delegate()', hit)
        self.contains('point, gfx::Insets(kResizeTopBorderThickness)', hit)
        self.contains('if (delegate && delegate->CanResize()) {', hit)
        self.contains('kResizeAreaCornerSize, kResizeAreaCornerSize, true);', hit)
        self.contains('if (edge != HTNOWHERE) {\n        return edge;\n      }', hit)
        self.assertLess(hit.index('GetHTComponentForFrame('), hit.index('OpaqueBrowserFrameView::NonClientHitTest(point)'))

    def test_the_host_names_every_window_it_owns(self):
        self.contains('extern bool (*g_ardia_linux_borderless_frame)(const BrowserWindowInterface*);', self.host)
        self.contains('g_ardia_linux_borderless_frame = [](const BrowserWindowInterface* browser) {\n'
                      '    return browser && Hosts().contains(browser->GetSessionID().id());\n  };', self.host)
        self.assertLess(self.host.index('g_ardia_linux_frameless_app = &IsUtilityAppName;'),
                        self.host.index('g_ardia_linux_borderless_frame = '))

    def test_the_host_lays_the_frame_out_again_once_the_window_is_its_own(self):
        initialize = self.host[self.host.index('void ShellHostView::Initialize() {'):]
        initialize = initialize[:initialize.index('\n}\n')]
        self.contains('  LayoutOverlay();\n  RefreshEngineFrame();\n', initialize)
        refresh = self.host[self.host.index('void ShellHostView::RefreshEngineFrame() {'):]
        refresh = refresh[:refresh.index('\n}\n')]
        self.contains('GetWidget()->FrameTypeChanged();', refresh)
        self.contains('frame->InvalidateLayout();', refresh)
        self.contains('frame->SchedulePaint();\n  HideCaptionButtons();', refresh)

    def test_the_docs_say_what_the_frame_does(self):
        docs = (ROOT.parents[1] / 'docs/linux-port.md').read_text()
        outer = docs[docs.index('- **Outer frame.**'):]
        outer = outer[:outer.index('- **Menu button.**')]
        self.contains('chromium-linux-borderless-frame.patch', outer)
        self.assertNotIn("doesn't replace its frame", outer)


if __name__ == '__main__':
    unittest.main()
