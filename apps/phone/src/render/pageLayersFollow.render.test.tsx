import { act } from "react-test-renderer";
import { useBrowse } from "../state/browse/store";
import { startPageUi } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { useTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

beforeAll(() => startPageUi());

beforeEach(() => {
  withTabs(2);
  useBrowse.setState({ surface: "browsing", sheet: null });
});

test("once the page UI has started, leaving the page closes its menu and reader, so the subscription no longer hangs on when its module happens to load", () => {
  act(() => usePageUi.setState({ menuOpen: true, readerTabId: useTabs.getState().selectedId }));
  act(() => useBrowse.setState({ surface: "deck" }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(usePageUi.getState().readerTabId).toBeNull();
});

test("switching to another tab closes the page's menu too", () => {
  const other = useTabs.getState().open.find((tab) => tab.id !== useTabs.getState().selectedId)!.id;
  act(() => usePageUi.setState({ menuOpen: true }));
  act(() => useTabs.setState({ selectedId: other }));
  expect(usePageUi.getState().menuOpen).toBe(false);
});
