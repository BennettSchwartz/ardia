package com.ardia.phone

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MaterialSchemeTest {
    private fun colourGetters(): Set<String> = ColorScheme::class.java.methods
        .filter { it.parameterCount == 0 && it.returnType == Long::class.javaPrimitiveType && it.name.startsWith("get") && it.name.contains("-") }
        .map { method -> method.name.removePrefix("get").substringBefore('-').replaceFirstChar(Char::lowercaseChar) }
        .filterNot { it.contains("Fixed") }
        .toSet()

    @Test
    fun theKeysAreComposesColorSchemeRolesWithoutTheFixedSet() {
        val keys = MaterialScheme.roles(lightColorScheme()).keys
        assertEquals(colourGetters(), keys)
        assertEquals(36, keys.size)
    }

    @Test
    fun valuesAreHexWithoutAlpha() {
        val roles = MaterialScheme.roles(darkColorScheme(primary = Color(0x80123456)))
        assertEquals("#123456", roles["primary"])
        assertTrue(roles.values.all { Regex("#[0-9A-F]{6}").matches(it) })
    }

    @Test
    @Config(sdk = [30])
    fun belowAndroid12ThereIsNoDynamicScheme() {
        assertNull(MaterialScheme.of(RuntimeEnvironment.getApplication()))
    }

    @Test
    fun fromAndroid12TheSchemeHasEveryRoleForLightAndDark() {
        val schemes = MaterialScheme.of(RuntimeEnvironment.getApplication())!!
        assertEquals(setOf("light", "dark"), schemes.keys)
        assertEquals(36, schemes["light"]!!.size)
        assertEquals(36, schemes["dark"]!!.size)
    }
}
