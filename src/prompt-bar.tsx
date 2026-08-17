/**
 * Barra inferior. El texto del prompt vive en CustomInput; el App no re-renderiza por tecla.
 */
import { Box, Text } from "ink";
import { memo, type MutableRefObject, type ReactNode } from "react";
import { C } from "./midnight.js";
import type { UiMode } from "./parse.js";
import { CustomInput } from "./custom-input.js";

type PromptBarProps = {
  draftRef: MutableRefObject<string>;
  resetTick: number;
  onSubmit: (v: string) => void;
  busy: boolean;
  uiMode: UiMode;
  accent: string;
  away: boolean;
  connectMode: boolean;
  pending: unknown[];
  focus: "tree" | "buf";
  version: string;
};

function PromptBarInner(props: PromptBarProps): ReactNode {
  const { draftRef, resetTick, onSubmit, busy, uiMode, accent, away, connectMode, pending, focus, version } = props;

  const placeholder = busy ? "Ctrl+C cancela" : "Enter command…  /help";
  const inputOffsetX = 3 + uiMode.toUpperCase().length + 3;

  return (
    <Box paddingX={1} marginBottom={1} flexDirection="column" backgroundColor={C.bg}>
      <Box borderStyle="round" borderColor={busy ? C.amber : accent} paddingX={1} backgroundColor={C.panel}>
        <Text color={accent} bold>
          {uiMode.toUpperCase()}
        </Text>
        <Text color={accent}> ▌ </Text>
        {away ? (
          <Text dimColor>en $EDITOR — guardá y salí</Text>
        ) : pending.length ? (
          <Text color={C.amber}>y acepta · n revierte · a todos · r todos</Text>
        ) : uiMode === "editor" ? (
          <Text dimColor>
            {focus === "buf"
              ? "arrastrá para sombrear · ctrl+c copia · ctrl+p pega"
              : "j/k árbol · enter/click abre · rueda · tab modo"}
          </Text>
        ) : connectMode ? (
          <CustomInput
            draftRef={draftRef}
            resetTick={resetTick}
            onSubmit={onSubmit}
            placeholder="sk-…"
            mask="*"
            offsetX={inputOffsetX}
          />
        ) : (
          <CustomInput
            draftRef={draftRef}
            resetTick={resetTick}
            onSubmit={onSubmit}
            placeholder={placeholder}
            offsetX={inputOffsetX}
          />
        )}
      </Box>
      <Text dimColor>
        {busy ? "ctrl+c cancela · ctrl+p proc" : "[TAB] Mode  [CTRL+P] Proc  [/help]  v" + version}
      </Text>
    </Box>
  );
}

export const PromptBar = memo(PromptBarInner, (prev, next) => {
  return (
    prev.resetTick === next.resetTick &&
    prev.busy === next.busy &&
    prev.uiMode === next.uiMode &&
    prev.accent === next.accent &&
    prev.away === next.away &&
    prev.connectMode === next.connectMode &&
    prev.pending === next.pending &&
    prev.focus === next.focus &&
    prev.version === next.version
  );
});
