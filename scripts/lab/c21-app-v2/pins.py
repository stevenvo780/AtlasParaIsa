"""Typed, exhaustive dependency closure. No volatile paths or named exceptions."""
import hashlib
import json
import os
from pathlib import Path


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1048576), b''):
            h.update(chunk)
    return h.hexdigest()


def closure(root):
    root = Path(root).resolve(strict=True)
    entries = {}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(parent) / name
            rel = path.relative_to(root).as_posix()
            current = root
            for part in path.relative_to(root).parts[:-1]:
                current /= part
                if current.is_symlink() or not current.is_dir():
                    raise RuntimeError('DEPENDENCY_PARENT_ROUTE:' + rel)
            if path.is_dir() and not path.is_symlink():
                entries[rel] = {'kind': 'directory'}
                continue
            chain = []
            target = path
            seen = set()
            while target.is_symlink():
                if target in seen:
                    raise RuntimeError('DEPENDENCY_LINK_CYCLE:' + rel)
                seen.add(target)
                text = os.readlink(target)
                if os.path.isabs(text):
                    raise RuntimeError('DEPENDENCY_ABSOLUTE_LINK:' + rel)
                next_path = Path(os.path.normpath(target.parent / text))
                if not next_path.is_relative_to(root):
                    raise RuntimeError('DEPENDENCY_ESCAPE:' + rel)
                current = root
                for part in next_path.relative_to(root).parts[:-1]:
                    current /= part
                    if current.is_symlink() or not current.is_dir():
                        raise RuntimeError('DEPENDENCY_PARENT_ROUTE:' + rel)
                chain.append({'path': target.relative_to(root).as_posix(), 'text': text,
                              'textSha256': hashlib.sha256(os.fsencode(text)).hexdigest(),
                              'target': next_path.relative_to(root).as_posix()})
                target = next_path
            if not target.is_file():
                raise RuntimeError('DEPENDENCY_DANGLING_OR_SPECIAL:' + rel)
            entries[rel] = {'kind': 'symlink' if chain else 'file', 'chain': chain,
                            'target': target.relative_to(root).as_posix(),
                            'bytes': target.stat().st_size, 'sha256': sha(target)}
    return entries


def verify_pins(root, pins):
    for rel, expected in pins.items():
        path = Path(root) / rel
        if path.is_symlink() or sha(path) != expected:
            raise RuntimeError('PIN_CHANGED:' + rel)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
