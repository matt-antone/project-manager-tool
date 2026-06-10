"use client";

import { memo, useCallback, useMemo, useRef } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertTable,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  toolbarPlugin
} from "@mdxeditor/editor";

type MarkdownEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  placeholder: string;
  overlayContainer?: HTMLElement | null;
};

function MarkdownEditorImpl(props: MarkdownEditorProps) {
  const initialMarkdownRef = useRef(props.markdown);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  const handleChange = useCallback((nextMarkdown: string) => {
    onChangeRef.current(nextMarkdown);
  }, []);

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      tablePlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      markdownShortcutPlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <DiffSourceToggleWrapper>
            <UndoRedo />
            <Separator />
            <BoldItalicUnderlineToggles />
            <CreateLink />
            <InsertTable />
            <Separator />
            <ListsToggle />
            <BlockTypeSelect />
          </DiffSourceToggleWrapper>
        )
      })
    ],
    []
  );

  return (
    <MDXEditor
      markdown={initialMarkdownRef.current}
      onChange={handleChange}
      placeholder={props.placeholder}
      overlayContainer={props.overlayContainer ?? undefined}
      className="commentMdxEditor"
      contentEditableClassName="markdownContent"
      plugins={plugins}
    />
  );
}

const MarkdownEditor = memo(
  MarkdownEditorImpl,
  (prev, next) =>
    prev.placeholder === next.placeholder && prev.overlayContainer === next.overlayContainer
);

export default MarkdownEditor;
