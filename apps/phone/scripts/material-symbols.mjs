import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../assets/material-symbols.json", import.meta.url), "utf8"));
for (const icon of [...Object.values(manifest.javascript), ...Object.values(manifest.android)]) {
  if (!manifest.icons[icon]?.paths.length) throw new Error(`Missing Material artwork: ${icon}`);
}
const output = fileURLToPath(new URL("../android/ardia-design/src/main/java/com/ardia/design/ArdiaSymbols.kt", import.meta.url));
const declarations = Object.entries(manifest.android).map(([name, icon]) => {
  const { viewBox, paths } = manifest.icons[icon];
  return `    val ${name} by lazy { material(${JSON.stringify(icon)}, ${viewBox === "0 -960 960 960"}, ${paths.map((path) => JSON.stringify(path)).join(", ")}) }`;
});
const aliases = Object.entries(manifest.systemNames).map(([name, property]) => `        ${JSON.stringify(name)} to { ${property} },`);
const source = `package com.ardia.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private fun material(name: String, scaled: Boolean, vararg paths: String): ImageVector {
    val builder = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    if (scaled) builder.addGroup(scaleX = 0.025f, scaleY = 0.025f, translationY = 24f)
    for (path in paths) builder.addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black))
    if (scaled) builder.clearGroup()
    return builder.build()
}

object ArdiaSymbols {
${declarations.join("\n")}
    val eyes by lazy {
        ImageVector.Builder(name = "eyes", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            addPath(
                pathData = addPathNodes("M4 12A3.6 7 0 1 1 11.2 12A3.6 7 0 1 1 4 12ZM12.8 12A3.6 7 0 1 1 20 12A3.6 7 0 1 1 12.8 12ZM5.25 13A1.65 2.8 0 1 1 8.55 13A1.65 2.8 0 1 1 5.25 13ZM14.05 13A1.65 2.8 0 1 1 17.35 13A1.65 2.8 0 1 1 14.05 13Z"),
                pathFillType = PathFillType.EvenOdd,
                fill = SolidColor(Color.Black),
            )
        }.build()
    }

    private val byName: Map<String, () -> ImageVector> = mapOf(
${aliases.join("\n")}
    )

    fun named(sfSymbol: String): ImageVector? = byName[sfSymbol]?.invoke()
}
`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== source) throw new Error("Android Material symbols need regenerating");
} else {
  writeFileSync(output, source);
}
