package com.ardia.phone

import com.ardia.phone.MaterialMenuRules.Bounds
import com.ardia.phone.NativeMenuRules.ActionSheetActionShape
import com.ardia.phone.NativeMenuRules.MenuItemShape
import org.junit.Assert.assertEquals
import org.junit.Test

class MaterialMenuRulesTest {
    @Test
    fun aButtonsMenuHangsFromTheWholeButtonEvenOnALongPressSoItNeverCoversIt() {
        assertEquals("the + button, 48dp at density 2.75, long pressed in its middle", Bounds(900, 2200, 132, 132), MaterialMenuRules.anchor(900, 2200, 132, 132, 2.75f, 66f, 66f))
        assertEquals("a tap opens from the button too", Bounds(900, 2200, 132, 132), MaterialMenuRules.anchor(900, 2200, 132, 132, 2.75f, null, null))
    }

    @Test
    fun aRowsMenuDropsBelowTheRowAtTheFingerSoItNeverCoversTheRow() {
        assertEquals("the Archive row, 1000 by 198 px, long pressed at 300,120", Bounds(340, 900, 1, 198), MaterialMenuRules.anchor(40, 900, 1000, 198, 2.75f, 300f, 120f))
        assertEquals("the Settings interval row tapped on its right-aligned value", Bounds(1010, 1500, 1, 154), MaterialMenuRules.anchor(40, 1500, 1000, 154, 2.75f, 970f, 70f))
        assertEquals("a press past the row's edge stays on the row", Bounds(1039, 1500, 1, 154), MaterialMenuRules.anchor(40, 1500, 1000, 154, 2.75f, 1200f, 70f))
    }

    @Test
    fun aTapShownFromJavaScriptUsesTheTouchThatJustWentDownAndNotAnOldOne() {
        assertEquals(true, MaterialMenuRules.recentTouch(5_000L, 5_300L))
        assertEquals(false, MaterialMenuRules.recentTouch(5_000L, 7_000L))
        assertEquals(false, MaterialMenuRules.recentTouch(null, 7_000L))
    }

    @Test
    fun aLargeViewsLongPressOpensTheMenuAtTheFinger() {
        assertEquals(Bounds(140, 830, 1, 1), MaterialMenuRules.anchor(40, 600, 480, 720, 2.75f, 100f, 230f))
    }

    @Test
    fun groupsBecomeSectionsWithADividerBetweenEach() {
        val rows = NativeMenuRules.rows(
            listOf(
                MenuItemShape("0", "Copy Link"),
                MenuItemShape("1", "Share"),
                MenuItemShape("g1", "Spaces", inline = true, children = listOf(MenuItemShape("2", "Work"), MenuItemShape("3", "Home"))),
                MenuItemShape("4", "Close Tab", destructive = true),
            ),
        )
        assertEquals(listOf(2, 3, 1), MaterialMenuRules.sections(rows).map { it.size })
        assertEquals(emptyList<List<NativeMenuRules.Row>>(), MaterialMenuRules.sections(emptyList()))
    }

    @Test
    fun theFirstChoiceSitsAtTheEndNextToCancelAsMaterialPlacesTheConfirmingAction() {
        val sheet = NativeMenuRules.sheet(listOf(ActionSheetActionShape("keep", "Keep"), ActionSheetActionShape("close", "Close All", destructive = true), ActionSheetActionShape("cancel", "Cancel", cancel = true)))
        assertEquals(listOf("close", "keep"), MaterialMenuRules.buttonsInOrder(sheet).map { it.id })
    }

    @Test
    fun newRowsReachAnOpenMenuAndKeepTheSubmenuItWasShowing() {
        val before = NativeMenuRules.rows(listOf(MenuItemShape("t", "Theme", children = listOf(MenuItemShape("l", "Light", checked = true), MenuItemShape("d", "Dark")))))
        val after = NativeMenuRules.rows(listOf(MenuItemShape("t", "Theme", children = listOf(MenuItemShape("l", "Light"), MenuItemShape("d", "Dark", checked = true)))))
        val open = listOf(MaterialMenuRules.Page(null, before), MaterialMenuRules.Page("Theme", (before.single() as NativeMenuRules.Action).item.children!!))
        val refreshed = MaterialMenuRules.refreshed(open, after)
        assertEquals(listOf(null, "Theme"), refreshed.map { it.title })
        val dark = refreshed.last().rows.filterIsInstance<NativeMenuRules.Action>().single { it.item.id == "d" }
        assertEquals(true, dark.item.checked)
    }

    @Test
    fun aSubmenuThatIsGoneAfterTheUpdateFallsBackToTheTop() {
        val before = NativeMenuRules.rows(listOf(MenuItemShape("t", "Theme", children = listOf(MenuItemShape("l", "Light")))))
        val after = NativeMenuRules.rows(listOf(MenuItemShape("c", "Copy Link")))
        val open = listOf(MaterialMenuRules.Page(null, before), MaterialMenuRules.Page("Theme", (before.single() as NativeMenuRules.Action).item.children!!))
        assertEquals(listOf<String?>(null), MaterialMenuRules.refreshed(open, after).map { it.title })
    }

    @Test
    fun aMenuRowCarriesItsIconToTheNativeMenu() {
        val rows = NativeMenuRules.rows(listOf(MenuItemShape("0", "Share", systemImage = "square.and.arrow.up")))
        assertEquals("square.and.arrow.up", (rows.single() as NativeMenuRules.Action).item.systemImage)
    }
}
