#!/usr/bin/env python3
"""
Caught Lying - Clip gatherer for politician compilation videos.

Usage:
  python clipper.py add       — download a clip and tag it
  python clipper.py list      — browse saved clips
  python clipper.py search    — search by politician or keyword
  python clipper.py export    — print an ffmpeg concat list for a politician
"""

import sqlite3
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

DB_PATH = Path("clips.db")
CLIPS_DIR = Path("clips")
console = Console()


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS clips (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            politician  TEXT    NOT NULL,
            claim       TEXT    NOT NULL,
            receipt     TEXT    NOT NULL,
            source_url  TEXT    NOT NULL,
            start_time  TEXT,
            end_time    TEXT,
            file_path   TEXT,
            added_at    TEXT    NOT NULL
        )
    """)
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

def _sanitize(name: str) -> str:
    return re.sub(r"[^\w\-]", "_", name)


def download_clip(url: str, start: str | None, end: str | None, out_path: Path) -> bool:
    """Download a full video or a time-trimmed section using yt-dlp + ffmpeg."""
    CLIPS_DIR.mkdir(exist_ok=True)

    ydl_args = [
        "yt-dlp",
        "--quiet",
        "--no-warnings",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4",
        "--merge-output-format", "mp4",
        "-o", str(out_path),
        url,
    ]

    if start or end:
        # Use yt-dlp's built-in download sections (requires ffmpeg)
        section = f"*{start or '0:00'}-{end or 'inf'}"
        ydl_args += ["--download-sections", section, "--force-keyframes-at-cuts"]

    result = subprocess.run(ydl_args, capture_output=True, text=True)
    if result.returncode != 0:
        console.print(f"[red]yt-dlp error:[/red] {result.stderr.strip()}")
        return False
    return True


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Caught Lying — clip manager for politician compilation videos."""


@cli.command()
def add():
    """Download a clip and save it with metadata."""
    console.rule("[bold red]Add a clip")

    politician = click.prompt("Politician name").strip()
    claim      = click.prompt("What did they claim?").strip()
    receipt    = click.prompt("What's the receipt / proof they lied?").strip()
    url        = click.prompt("YouTube (or other) URL").strip()
    start      = click.prompt("Start timestamp (e.g. 1:23 or 0:00:00) — leave blank for full video", default="").strip() or None
    end        = click.prompt("End timestamp — leave blank for full video", default="").strip() or None

    slug = f"{_sanitize(politician)}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out_path = CLIPS_DIR / f"{slug}.mp4"

    console.print("\n[yellow]Downloading...[/yellow]")
    ok = download_clip(url, start, end, out_path)

    file_path = str(out_path) if ok and out_path.exists() else None
    if not ok:
        keep = click.confirm("Download failed. Save metadata anyway?", default=False)
        if not keep:
            console.print("[red]Aborted.[/red]")
            return

    conn = get_db()
    conn.execute(
        "INSERT INTO clips (politician, claim, receipt, source_url, start_time, end_time, file_path, added_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (politician, claim, receipt, url, start, end, file_path, datetime.now().isoformat()),
    )
    conn.commit()

    console.print(f"\n[green]Saved![/green] File: {file_path or '(no file)'}")


@cli.command(name="list")
def list_clips():
    """List all saved clips."""
    conn = get_db()
    rows = conn.execute("SELECT * FROM clips ORDER BY politician, added_at").fetchall()

    if not rows:
        console.print("[dim]No clips yet. Run [bold]add[/bold] to get started.[/dim]")
        return

    table = Table(title="Saved Clips", show_lines=True)
    table.add_column("ID",        style="dim",    width=4)
    table.add_column("Politician", style="cyan",  min_width=16)
    table.add_column("Claim",      style="white", min_width=28)
    table.add_column("Receipt",    style="green", min_width=28)
    table.add_column("File",       style="dim",   min_width=14)

    for r in rows:
        has_file = "[green]✓[/green]" if r["file_path"] and Path(r["file_path"]).exists() else "[red]✗[/red]"
        table.add_row(str(r["id"]), r["politician"], r["claim"], r["receipt"], has_file)

    console.print(table)


@cli.command()
@click.argument("query")
def search(query: str):
    """Search clips by politician name or keyword in claim/receipt."""
    conn = get_db()
    like = f"%{query}%"
    rows = conn.execute(
        "SELECT * FROM clips WHERE politician LIKE ? OR claim LIKE ? OR receipt LIKE ? ORDER BY politician",
        (like, like, like),
    ).fetchall()

    if not rows:
        console.print(f"[dim]No results for '{query}'.[/dim]")
        return

    table = Table(title=f"Results for '{query}'", show_lines=True)
    table.add_column("ID",         style="dim",   width=4)
    table.add_column("Politician", style="cyan",  min_width=16)
    table.add_column("Claim",      style="white", min_width=28)
    table.add_column("Receipt",    style="green", min_width=28)
    table.add_column("Source URL", style="blue",  min_width=20)

    for r in rows:
        table.add_row(str(r["id"]), r["politician"], r["claim"], r["receipt"], r["source_url"])

    console.print(table)


@cli.command()
@click.argument("politician")
def export(politician: str):
    """Print an ffmpeg concat list for all clips of a given politician."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM clips WHERE politician LIKE ? AND file_path IS NOT NULL ORDER BY added_at",
        (f"%{politician}%",),
    ).fetchall()

    valid = [r for r in rows if r["file_path"] and Path(r["file_path"]).exists()]

    if not valid:
        console.print(f"[red]No downloaded clips found for '{politician}'.[/red]")
        return

    out_file = f"concat_{_sanitize(politician)}.txt"
    lines = [f"file '{Path(r['file_path']).resolve()}'" for r in valid]
    Path(out_file).write_text("\n".join(lines) + "\n")

    console.print(f"[green]Wrote {len(lines)} entries to [bold]{out_file}[/bold][/green]")
    console.print(f"\nTo merge into one video:\n  [cyan]ffmpeg -f concat -safe 0 -i {out_file} -c copy {_sanitize(politician)}_compilation.mp4[/cyan]")


@cli.command()
@click.argument("clip_id", type=int)
def delete(clip_id: int):
    """Remove a clip record (and optionally its file) by ID."""
    conn = get_db()
    row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if not row:
        console.print(f"[red]No clip with ID {clip_id}.[/red]")
        return

    console.print(f"[cyan]{row['politician']}[/cyan] — {row['claim']}")
    if row["file_path"] and Path(row["file_path"]).exists():
        if click.confirm(f"Also delete file {row['file_path']}?", default=False):
            Path(row["file_path"]).unlink()
            console.print("[dim]File deleted.[/dim]")

    conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
    conn.commit()
    console.print("[green]Record removed.[/green]")


if __name__ == "__main__":
    cli()
