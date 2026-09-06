import { Fragment, useState, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

export function safeMarkdownLink(href: string): string | undefined {
	try {
		const url = new URL(href);
		return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
	} catch { return undefined; }
}

function CodeBlock({ text, language }: { text: string; language?: string }) {
	const [copied, setCopied] = useState(false);
	return <div className="code-block"><div><span>{language || "文本"}</span><button type="button" onClick={() => {
		void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false));
	}}>{copied ? "已复制" : "复制"}</button></div><pre><code>{text}</code></pre></div>;
}

function render(tokens: Token[], depth = 0): ReactNode {
	if (depth > 20) return null;
	return tokens.map((token, index) => {
		const children = () => render("tokens" in token ? token.tokens ?? [] : [], depth + 1);
		let node: ReactNode;
		switch (token.type) {
			case "space": node = null; break;
			case "heading": node = <div role="heading" aria-level={token.depth} className={`md-heading h${token.depth}`}>{children()}</div>; break;
			case "paragraph": node = <p>{children()}</p>; break;
			case "text": node = token.tokens ? children() : token.text; break;
			case "strong": node = <strong>{children()}</strong>; break;
			case "em": node = <em>{children()}</em>; break;
			case "del": node = <del>{children()}</del>; break;
			case "codespan": node = <code>{token.text}</code>; break;
			case "code": node = <CodeBlock text={token.text} language={token.lang} />; break;
			case "blockquote": node = <blockquote>{children()}</blockquote>; break;
			case "br": node = <br />; break;
			case "hr": node = <hr />; break;
			case "link": {
				const href = safeMarkdownLink(token.href);
				node = href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children()}</a> : children();
				break;
			}
			case "image": node = <span className="muted">[图片：{token.text}]</span>; break;
			case "list": {
				const items = token.items.map((item: Tokens.ListItem, i: number) => <li key={i}>{item.task && <input type="checkbox" checked={item.checked} readOnly aria-label="任务状态" />}{render(item.tokens ?? [], depth + 1)}</li>);
				node = token.ordered ? <ol start={token.start || 1}>{items}</ol> : <ul>{items}</ul>;
				break;
			}
			case "table": node = <div className="table-scroll"><table><thead><tr>{token.header.map((cell: { tokens: Token[] }, i: number) => <th key={i}>{render(cell.tokens, depth + 1)}</th>)}</tr></thead><tbody>{token.rows.map((row: { tokens: Token[] }[], i: number) => <tr key={i}>{row.map((cell, j) => <td key={j}>{render(cell.tokens, depth + 1)}</td>)}</tr>)}</tbody></table></div>; break;
			default: node = token.raw; // Raw HTML remains escaped React text.
		}
		return <Fragment key={index}>{node}</Fragment>;
	});
}

export function Markdown({ text }: { text: string }) {
	return <div className="markdown">{render(Lexer.lex(text.slice(0, 200_000), { gfm: true }))}</div>;
}
