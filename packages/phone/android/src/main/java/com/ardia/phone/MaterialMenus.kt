package com.ardia.phone

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal object MaterialMenuRules {
    const val BUTTON_MAX_DP = 120f
    const val EXIT_MS = 160L

    data class Bounds(val left: Int, val top: Int, val width: Int, val height: Int)

    fun anchor(viewLeft: Int, viewTop: Int, viewWidth: Int, viewHeight: Int, density: Float, pressX: Float?, pressY: Float?): Bounds {
        val button = viewWidth / density <= BUTTON_MAX_DP && viewHeight / density <= BUTTON_MAX_DP
        if (pressX == null || pressY == null || button) return Bounds(viewLeft, viewTop, viewWidth, viewHeight)
        return Bounds(viewLeft + pressX.toInt(), viewTop + pressY.toInt(), 1, 1)
    }

    fun sections(rows: List<NativeMenuRules.Row>): List<List<NativeMenuRules.Row>> {
        val sections = mutableListOf<MutableList<NativeMenuRules.Row>>()
        var group: Int? = null
        for (row in rows) {
            if (row.group != group || sections.isEmpty()) sections += mutableListOf<NativeMenuRules.Row>()
            group = row.group
            sections.last() += row
        }
        return sections
    }

    data class Page(val title: String?, val rows: List<NativeMenuRules.Row>)

    fun buttonsInOrder(sheet: NativeMenuRules.Sheet): List<NativeMenuRules.ActionSheetActionShape> = sheet.buttons.asReversed()
}

@Composable
internal fun MaterialMenu(scheme: ColorScheme, expanded: MutableState<Boolean>, rows: List<NativeMenuRules.Row>, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    MaterialTheme(colorScheme = scheme) {
        Box(Modifier.fillMaxSize()) {
            DropdownMenu(expanded = expanded.value, onDismissRequest = onDismiss) {
                MaterialMenuPages(rows, onPick)
            }
        }
    }
}

@Composable
private fun MaterialMenuPages(rows: List<NativeMenuRules.Row>, onPick: (String) -> Unit) {
    var pages by remember { mutableStateOf(listOf(MaterialMenuRules.Page(null, rows))) }
    val page = pages.last()
    val scheme = MaterialTheme.colorScheme
    page.title?.let { title ->
        DropdownMenuItem(
            text = { Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            onClick = { pages = pages.dropLast(1) },
            leadingIcon = { Icon(SettingsSymbols.vector("chevron.left"), contentDescription = null, modifier = Modifier.size(20.dp)) },
            colors = MenuDefaults.itemColors(textColor = scheme.onSurface, leadingIconColor = scheme.onSurfaceVariant),
        )
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = scheme.outlineVariant)
    }
    MaterialMenuRules.sections(page.rows).forEachIndexed { index, section ->
        if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp), color = scheme.outlineVariant)
        for (row in section) {
            when (row) {
                is NativeMenuRules.Header -> Text(
                    row.title,
                    style = MaterialTheme.typography.labelLarge,
                    color = scheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics { heading() },
                )
                is NativeMenuRules.Action -> MaterialMenuRow(row.item, onOpen = { children -> pages = pages + MaterialMenuRules.Page(row.item.title, children) }, onPick = onPick)
            }
        }
    }
}

@Composable
private fun MaterialMenuRow(item: NativeMenuRules.Item, onOpen: (List<NativeMenuRules.Row>) -> Unit, onPick: (String) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val text = if (item.destructive) scheme.error else scheme.onSurface
    val icon = if (item.destructive) scheme.error else scheme.onSurfaceVariant
    val children = item.children
    val leading = item.systemImage?.let(SettingsSymbols::known)
    val trailing = when {
        children != null -> SettingsSymbols.vector("chevron.right")
        item.checked -> SettingsSymbols.vector("checkmark")
        else -> null
    }
    DropdownMenuItem(
        text = {
            Column {
                Text(item.title, style = MaterialTheme.typography.bodyLarge)
                item.subtitle?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant) }
            }
        },
        onClick = { if (children != null) onOpen(children) else onPick(item.id) },
        modifier = Modifier.semantics { if (item.checked) selected = true },
        leadingIcon = leading?.let { vector -> { Icon(vector, contentDescription = null, modifier = Modifier.size(24.dp)) } },
        trailingIcon = trailing?.let { vector -> { Icon(vector, contentDescription = null, modifier = Modifier.size(20.dp)) } },
        enabled = !item.disabled,
        colors = MenuDefaults.itemColors(textColor = text, leadingIconColor = icon, trailingIconColor = icon),
    )
}

@Composable
internal fun MaterialSheetDialog(scheme: ColorScheme, title: String?, message: String?, sheet: NativeMenuRules.Sheet, answer: (String?) -> Unit) {
    MaterialTheme(colorScheme = scheme) {
        val colors = MaterialTheme.colorScheme
        AlertDialog(
            onDismissRequest = { answer(null) },
            confirmButton = {
                Row {
                    for (action in MaterialMenuRules.buttonsInOrder(sheet)) {
                        TextButton(onClick = { answer(action.id) }, colors = if (action.destructive) ButtonDefaults.textButtonColors(contentColor = colors.error) else ButtonDefaults.textButtonColors()) {
                            Text(action.title)
                        }
                    }
                }
            },
            dismissButton = { TextButton(onClick = { answer(null) }) { Text(sheet.cancelTitle) } },
            title = title?.takeIf { it.isNotEmpty() }?.let { { Text(it) } },
            text = when {
                sheet.listed.isNotEmpty() -> {
                    {
                        Column {
                            message?.takeIf { it.isNotEmpty() }?.let { Text(it, modifier = Modifier.padding(bottom = 8.dp)) }
                            for (action in sheet.listed) {
                                Box(
                                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) { answer(action.id) },
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    Text(action.title, style = MaterialTheme.typography.bodyLarge, color = if (action.destructive) colors.error else colors.onSurface)
                                }
                            }
                        }
                    }
                }
                else -> message?.takeIf { it.isNotEmpty() }?.let { { Text(it) } }
            },
        )
    }
}
