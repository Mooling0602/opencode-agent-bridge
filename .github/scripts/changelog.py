#!/usr/bin/env python3
"""
changelog.py - Extract a release section from CHANGELOG.md for CI.

用法:
  changelog.py <changelog.md> <tag> [--compare-link <url>] [--output <file>]

- 提取 "## <tag>" 章节内容（从该标题行之后到下一个 "## " 标题之前）
- 章节中的 **#full_changelog** 占位符替换为 --compare-link 提供的链接
- 未找到对应章节时打印错误并以非零退出码失败（防止发布无内容的 Release）
"""

import argparse
import sys
from pathlib import Path


def extract_section(changelog_path: Path, tag: str, compare_link: str) -> str:
    lines = changelog_path.read_text(encoding="utf-8").splitlines()

    section: list[str] = []
    capture = False
    found = False
    for line in lines:
        if line.startswith("## "):
            if capture:
                break
            capture = line[3:].strip() == tag
            if capture:
                found = True
            continue
        if capture:
            section.append(line)

    if not found:
        print(f"Missing changelog section for tag {tag!r} in {changelog_path}", file=sys.stderr)
        sys.exit(1)

    body = "\n".join(
        line.replace("**#full_changelog**", f"**Full changelog**: {compare_link}")
        for line in section
    ).strip()

    return body


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract a release section from CHANGELOG.md for CI.",
        add_help=False,
    )
    parser.add_argument("changelog", help="Path to CHANGELOG.md")
    parser.add_argument("tag", help="Version tag (no v prefix, e.g. 0.1.1)")
    parser.add_argument(
        "--compare-link",
        default="",
        help="Version compare URL replacing **#full_changelog** (optional)",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Write result to this file instead of stdout (optional)",
    )
    parser.add_argument(
        "--help", "-h", action="store_true", help="Show this help message and exit."
    )
    args = parser.parse_args()

    if args.help:
        parser.print_help()
        sys.exit(0)

    body = extract_section(Path(args.changelog), args.tag, args.compare_link)

    if args.output:
        Path(args.output).write_text(body + "\n", encoding="utf-8")
    else:
        print(body)


if __name__ == "__main__":
    main()
