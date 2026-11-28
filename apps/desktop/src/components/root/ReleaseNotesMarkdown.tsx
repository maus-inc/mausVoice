import { createMarkdownLink } from "../common/markdown-link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = { a: createMarkdownLink("a link in the release notes") };

// Release bodies are written as GFM by the release pipeline, and the same
// dialect renders everywhere else in the app, so tables and strikethrough in
// the notes must not degrade to raw pipe text here.
export const ReleaseNotesMarkdown = ({ children }: { children: string }) => (
  <Markdown remarkPlugins={[remarkGfm]} components={components}>
    {children}
  </Markdown>
);
