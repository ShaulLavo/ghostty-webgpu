import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
root.mkdir(exist_ok=True)
for name,edit in [('partial-scroll','\x1b[5;26r\x1b[26;1H\n'),('insert-delete-lines','\x1b[10;1H\x1b[2L\x1b[18;1H\x1b[2M')]:
    init='\x1bc\x1b[?1049h\x1b[?25l'+''.join(f'\x1b[{row};1HROW {row:02d} '+''.join(chr(33+(row+col)%90) for col in range(85)) for row in range(1,31))
    chunks=[init.encode()]+[(edit+f'\x1b[12;3H{n:06d}').encode() for n in range(512)]
    data=b''.join(chunks); offset=0; descriptors=[]
    for chunk in chunks:
        descriptors.append(dict(offset=offset,length=len(chunk)));offset+=len(chunk)
    (root/f'{name}.bin').write_bytes(data)
    (root/f'{name}.json').write_text(json.dumps(dict(name=name,cols=100,rows=30,sha256=hashlib.sha256(data).hexdigest(),byte_count=len(data),frame_count=len(chunks),chunks=descriptors),indent=2))
