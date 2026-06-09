# Caught Lying — Clip Gatherer

A CLI tool for building politician lie-compilation YouTube videos. Paste a URL, tag the claim and the receipt, and let it download the clip. When you're ready to edit, export an ffmpeg concat list to stitch everything together.

## Setup

```bash
pip install -r requirements.txt
# also requires ffmpeg on your PATH for trimmed downloads
```

## Usage

```bash
# Download a clip and tag it
python clipper.py add

# Browse everything saved
python clipper.py list

# Search by politician name or keyword
python clipper.py search "Biden"

# Generate an ffmpeg concat list for one politician
python clipper.py export "Biden"

# Remove a clip by ID
python clipper.py delete 3
```

## What gets stored

| Field | What it is |
|---|---|
| Politician | Who said it |
| Claim | The specific lie / misleading statement |
| Receipt | The proof / contradiction |
| Source URL | Where the original video lives |
| Start / End | Timestamps to trim to just the relevant moment |
| File | Local path to the downloaded clip |

Clips land in `./clips/`. The database is `clips.db` (SQLite).

## Exporting for editing

`python clipper.py export "Trump"` writes a `concat_Trump.txt` file and prints the exact `ffmpeg` command to merge all clips into one compilation video.
