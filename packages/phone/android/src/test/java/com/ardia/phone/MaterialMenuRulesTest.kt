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
    fun aMenuRowCarriesItsIconToTheNativeMenu() {
        val rows = NativeMenuRules.rows(listOf(MenuItemShape("0", "Share", systemImage = "square.and.arrow.up")))
        assertEquals("square.and.arrow.up", (rows.single() as NativeMenuRules.Action).item.systemImage)
    }
}
