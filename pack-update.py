"""Safe, non-executing extraction and portable ZIP creation for release payloads."""
import os, re, sys, stat, zipfile
from pathlib import Path

mode, source, destination = sys.argv[1:]
if mode == 'extract':
    target = Path(destination).resolve()
    target.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 100000 or sum(e.file_size for e in entries) > 8 * 1024**3:
            raise ValueError('Archive limits exceeded')
        seen, roots = set(), set()
        for entry in entries:
            name = entry.filename.rstrip('/')
            parts = name.split('/')
            if not name or any(not p or p in ('.', '..') or p[-1:] in (' ', '.') or re.search(r'[\\:\x00-\x1f<>"|?*]', p) for p in parts):
                raise ValueError('Unsafe archive path')
            if name.casefold() in seen or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Duplicate or linked archive path')
            seen.add(name.casefold()); roots.add(parts[0])
        if len(roots) != 1:
            raise ValueError('Candidate must contain one bundle directory')
        for entry in entries:
            if entry.is_dir(): continue
            parts = entry.filename.split('/')[1:]
            if not parts: raise ValueError('Bundle file outside directory')
            output = target / 'bundle' / Path(*parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as src, output.open('xb') as dest:
                while chunk := src.read(1024*1024): dest.write(chunk)
elif mode == 'zip':
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        base = Path(source)
        for item in sorted(base.rglob('*')):
            if item.is_symlink(): raise ValueError('Linked release file')
            if item.is_file():
                name = item.relative_to(base).as_posix()
                if (base / 'signed-update.json').exists() and name in ('bundle/web-update.json', 'bundle/bundle-reuse.json'): continue
                archive.write(item, name)
else:
    raise ValueError('Unknown mode')
