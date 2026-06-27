// Converts raw Figma node trees + variables into a clean, code-ready schema.
// The goal: drop Figma-internal noise, surface only what's needed to write markup/CSS.

function clamp255(n) {
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

function colorToCss(c, opacityOverride) {
  if (!c) return null;
  const a = opacityOverride != null ? opacityOverride : c.a != null ? c.a : 1;
  const r = clamp255(c.r);
  const g = clamp255(c.g);
  const b = clamp255(c.b);
  if (a >= 1) {
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function round(n, p = 2) {
  if (typeof n !== "number") return n;
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

function normalizePaint(paint) {
  if (!paint || paint.visible === false) return null;
  const opacity = paint.opacity != null ? paint.opacity : 1;
  switch (paint.type) {
    case "SOLID":
      return { type: "solid", color: colorToCss(paint.color, opacity) };
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      return {
        type: paint.type.replace("GRADIENT_", "").toLowerCase() + "-gradient",
        stops: (paint.gradientStops || []).map((s) => ({
          position: round(s.position),
          color: colorToCss(s.color),
        })),
      };
    case "IMAGE":
      return { type: "image", imageRef: paint.imageRef, scaleMode: paint.scaleMode };
    default:
      return { type: (paint.type || "unknown").toLowerCase() };
  }
}

function normalizeEffect(e) {
  if (!e || e.visible === false) return null;
  const base = { type: e.type };
  if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
    return {
      type: e.type === "INNER_SHADOW" ? "inner-shadow" : "drop-shadow",
      color: colorToCss(e.color),
      offsetX: round(e.offset && e.offset.x),
      offsetY: round(e.offset && e.offset.y),
      blur: round(e.radius),
      spread: round(e.spread || 0),
      css:
        `${e.type === "INNER_SHADOW" ? "inset " : ""}` +
        `${round(e.offset && e.offset.x)}px ${round(e.offset && e.offset.y)}px ` +
        `${round(e.radius)}px ${round(e.spread || 0)}px ${colorToCss(e.color)}`,
    };
  }
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    return { type: e.type.toLowerCase().replace("_", "-"), blur: round(e.radius) };
  }
  return base;
}

const ALIGN = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
  BASELINE: "baseline",
};

function normalizeLayout(node) {
  const box = node.absoluteBoundingBox;
  const layout = {};
  if (box) {
    layout.width = round(box.width);
    layout.height = round(box.height);
  }
  if (node.layoutMode && node.layoutMode !== "NONE") {
    layout.display = "flex";
    layout.flexDirection = node.layoutMode === "HORIZONTAL" ? "row" : "column";
    if (node.layoutWrap === "WRAP") layout.flexWrap = "wrap";
    if (node.itemSpacing) layout.gap = round(node.itemSpacing);
    const pad = {
      top: node.paddingTop || 0,
      right: node.paddingRight || 0,
      bottom: node.paddingBottom || 0,
      left: node.paddingLeft || 0,
    };
    if (pad.top || pad.right || pad.bottom || pad.left) {
      layout.padding = `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`;
    }
    if (node.primaryAxisAlignItems) layout.justifyContent = ALIGN[node.primaryAxisAlignItems];
    if (node.counterAxisAlignItems) layout.alignItems = ALIGN[node.counterAxisAlignItems];
  }
  if (node.layoutGrow) layout.flexGrow = node.layoutGrow;
  if (node.layoutAlign && node.layoutAlign !== "INHERIT") layout.alignSelf = node.layoutAlign;
  return Object.keys(layout).length ? layout : null;
}

function cornerRadius(node) {
  if (Array.isArray(node.rectangleCornerRadii)) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    if (tl === tr && tr === br && br === bl) return tl || null;
    return `${tl}px ${tr}px ${br}px ${bl}px`;
  }
  return node.cornerRadius || null;
}

function normalizeTypography(style) {
  if (!style) return null;
  const t = {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontSize: style.fontSize,
  };
  if (style.lineHeightPx) t.lineHeight = round(style.lineHeightPx);
  if (style.letterSpacing) t.letterSpacing = round(style.letterSpacing);
  if (style.textAlignHorizontal) t.textAlign = style.textAlignHorizontal.toLowerCase();
  if (style.textCase && style.textCase !== "ORIGINAL") t.textCase = style.textCase;
  if (style.textDecoration && style.textDecoration !== "NONE")
    t.textDecoration = style.textDecoration.toLowerCase();
  return t;
}

// Heuristic mapping from a Figma node to an HTML tag suggestion.
function tagHint(node) {
  if (node.type === "TEXT") {
    const size = node.style && node.style.fontSize;
    if (size && size >= 28) return "h1";
    if (size && size >= 22) return "h2";
    if (size && size >= 18) return "h3";
    return "p";
  }
  const name = (node.name || "").toLowerCase();
  if (/(^|[^a-z])(btn|button)([^a-z]|$)/.test(name)) return "button";
  if (/(^|[^a-z])(input|field|textbox)([^a-z]|$)/.test(name)) return "input";
  if (/(^|[^a-z])(img|image|photo|avatar)([^a-z]|$)/.test(name)) return "img";
  if (/(^|[^a-z])(link|nav)([^a-z]|$)/.test(name)) return "a";
  if (/(^|[^a-z])(list)([^a-z]|$)/.test(name)) return "ul";
  if (/(^|[^a-z])(card|section|container|wrapper|group)([^a-z]|$)/.test(name)) return "div";
  return "div";
}

// styleSink (optional): records styleId -> resolved value so we can build a
// practical token table even without the Enterprise variables endpoint.
function normalizeNode(node, opts = {}) {
  const { maxDepth = Infinity, depth = 0, styleSink } = opts;
  if (!node) return null;

  const fills = (node.fills || []).map(normalizePaint).filter(Boolean);
  const strokes = (node.strokes || []).map(normalizePaint).filter(Boolean);
  const effects = (node.effects || []).map(normalizeEffect).filter(Boolean);
  const typography = node.type === "TEXT" ? normalizeTypography(node.style) : null;

  if (styleSink && node.styles) {
    if (node.styles.fill && fills[0]) styleSink[node.styles.fill] = fills[0].color || fills[0];
    if (node.styles.text && typography) styleSink[node.styles.text] = typography;
    if (node.styles.effect && effects.length) styleSink[node.styles.effect] = effects;
    if (node.styles.stroke && strokes[0]) styleSink[node.styles.stroke] = strokes[0].color || strokes[0];
  }

  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    tag: tagHint(node),
  };

  if (node.type === "TEXT" && node.characters != null) out.text = node.characters;

  const layout = normalizeLayout(node);
  if (layout) out.layout = layout;

  const style = {};
  if (fills.length) style.fill = fills.length === 1 ? fills[0] : fills;
  if (strokes.length) {
    style.stroke = strokes.length === 1 ? strokes[0] : strokes;
    if (node.strokeWeight) style.strokeWidth = round(node.strokeWeight);
  }
  const radius = cornerRadius(node);
  if (radius != null) style.borderRadius = radius;
  if (effects.length) style.effects = effects;
  if (node.opacity != null && node.opacity !== 1) style.opacity = round(node.opacity);
  if (typography) style.typography = typography;
  if (Object.keys(style).length) out.style = style;

  // Component metadata
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.isComponent = true;
  if (node.type === "INSTANCE") {
    out.instanceOf = node.componentId;
    if (node.componentProperties) {
      out.props = Object.fromEntries(
        Object.entries(node.componentProperties).map(([k, v]) => [
          k.split("#")[0],
          v && v.value,
        ])
      );
    }
  }
  if (node.styles) out.styleRefs = node.styles;

  // Children
  if (node.children && depth < maxDepth) {
    const kids = node.children
      .filter((c) => c.visible !== false)
      .map((c) => normalizeNode(c, { ...opts, depth: depth + 1 }))
      .filter(Boolean);
    if (kids.length) out.children = kids;
  }
  return out;
}

// --- Variables / tokens ---

function buildVariableTokens(variablesData) {
  if (!variablesData || !variablesData.meta) return null;
  const { variables = {}, variableCollections = {} } = variablesData.meta;

  const resolve = (value, seen = new Set()) => {
    if (value && value.type === "VARIABLE_ALIAS") {
      if (seen.has(value.id)) return { alias: value.id };
      seen.add(value.id);
      const target = variables[value.id];
      if (!target) return { alias: value.id };
      const firstMode = Object.values(target.valuesByMode || {})[0];
      return resolve(firstMode, seen);
    }
    if (value && typeof value === "object" && "r" in value && "g" in value) {
      return colorToCss(value);
    }
    return value;
  };

  const collections = {};
  for (const col of Object.values(variableCollections)) {
    const modes = (col.modes || []).reduce((m, mode) => {
      m[mode.modeId] = mode.name;
      return m;
    }, {});
    collections[col.name] = { modes: Object.values(modes), variables: {} };
    for (const v of Object.values(variables)) {
      if (v.variableCollectionId !== col.id) continue;
      const byMode = {};
      for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
        byMode[modes[modeId] || modeId] = resolve(val);
      }
      collections[col.name].variables[v.name] = {
        type: v.resolvedType,
        values: byMode,
      };
    }
  }
  return collections;
}

// Combine style metadata names with values harvested during traversal.
function buildStyleTokens(stylesMeta, styleSink) {
  if (!stylesMeta) return null;
  const byType = {};
  for (const [id, meta] of Object.entries(stylesMeta)) {
    const kind = (meta.styleType || "OTHER").toLowerCase();
    byType[kind] = byType[kind] || {};
    byType[kind][meta.name] = {
      key: meta.key,
      description: meta.description || undefined,
      value: styleSink ? styleSink[id] : undefined,
    };
  }
  return byType;
}

module.exports = {
  colorToCss,
  normalizePaint,
  normalizeEffect,
  normalizeNode,
  buildVariableTokens,
  buildStyleTokens,
};
