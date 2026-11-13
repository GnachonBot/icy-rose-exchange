#!/usr/bin/env python3
"""Merge staff catalogue edits into the *existing* Excel file with OOXML.

No third-party libraries: untouched worksheets, formatting, formulas, images and
other archive members stay intact. Changes are limited to source input cells.

Usage: python scripts/sync_excel.py source/prices.xlsx /tmp/catalogue-export.json
"""
from __future__ import annotations
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from scripts.build_data import load_workbook

MAIN="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ET.register_namespace('',MAIN)
ET.register_namespace('r',REL)
C=lambda name:f"{{{MAIN}}}{name}"

class ExcelPatch:
    def __init__(self,path):
        self.path=Path(path)
        with zipfile.ZipFile(self.path) as archive:
            self.contents={info.filename:(info,archive.read(info.filename)) for info in archive.infolist()}
        root=ET.fromstring(self.contents['xl/workbook.xml'][1]);rels=ET.fromstring(self.contents['xl/_rels/workbook.xml.rels'][1]);relmap={r.attrib['Id']:r.attrib['Target'] for r in rels}
        self.sheet_paths={}
        for sheet in root.findall('.//'+C('sheet')):
            target=relmap[sheet.attrib[f'{{{REL}}}id']].lstrip('/')
            self.sheet_paths[sheet.attrib['name']]=target if target.startswith('xl/') else 'xl/'+target
        self.worksheets={}
        self.values=load_workbook(self.path)
        self.changed=False
    def tree(self,sheet):
        if sheet not in self.worksheets:
            self.worksheets[sheet]=ET.fromstring(self.contents[self.sheet_paths[sheet]][1])
        return self.worksheets[sheet]
    def get(self,sheet,ref):return self.values.get(sheet,{}).get(ref)
    def set(self,sheet,ref,value):
        previous=self.get(sheet,ref)
        if value is None:value=''
        if (previous is None or previous=='') and value=='':return
        if value!='' and previous==value:return
        self.changed=True
        root=self.tree(sheet);rows=root.find(C('sheetData'))
        rownum=int(re.search(r'\d+',ref).group());column=re.match(r'[A-Z]+',ref).group()
        row=next((r for r in rows.findall(C('row')) if int(r.attrib['r'])==rownum),None)
        if row is None:
            row=ET.Element(C('row'),{'r':str(rownum)})
            after=next((i for i,r in enumerate(list(rows)) if int(r.attrib.get('r',999999))>rownum),len(rows))
            rows.insert(after,row)
        cell=next((c for c in row.findall(C('c')) if c.attrib.get('r')==ref),None)
        if cell is None:
            cell=ET.Element(C('c'),{'r':ref})
            def colidx(s):
                n=0
                for char in s:n=n*26+ord(char)-64
                return n
            idx=colidx(column)
            after=next((i for i,c in enumerate(list(row)) if colidx(re.match(r'[A-Z]+',c.attrib.get('r','Z')).group())>idx),len(row))
            row.insert(after,cell)
        for child in list(cell):
            if child.tag in {C('v'),C('is'),C('f')} :cell.remove(child)
        cell.attrib.pop('t',None)
        if isinstance(value,str) and value:
            cell.attrib['t']='inlineStr';inline=ET.SubElement(cell,C('is'));text=ET.SubElement(inline,C('t'));text.text=value
        elif value!='':
            v=ET.SubElement(cell,C('v'));v.text=str(value)
        self.values.setdefault(sheet,{})[ref]=value
        # extend worksheet dimension when writing new columns
        dimension=root.find(C('dimension'))
        if dimension is not None:
            existing=dimension.attrib.get('ref','A1')
            ending=existing.split(':')[-1];endcol=re.match(r'[A-Z]+',ending).group();endrow=int(re.search(r'\d+',ending).group())
            def colnum(s):
                n=0
                for c in s:n=n*26+ord(c)-64
                return n
            if colnum(column)>colnum(endcol) or rownum>endrow:
                dimension.attrib['ref']=f"A1:{column if colnum(column)>colnum(endcol) else endcol}{max(rownum,endrow)}"
    def save(self):
        if not self.changed:return False
        wb=ET.fromstring(self.contents['xl/workbook.xml'][1]);calc=wb.find(C('calcPr'))
        if calc is not None:
            calc.set('fullCalcOnLoad','1');calc.set('forceFullCalc','1')
            self.contents['xl/workbook.xml']=(self.contents['xl/workbook.xml'][0],ET.tostring(wb,encoding='utf-8',xml_declaration=True))
        for name,root in self.worksheets.items():
            path=self.sheet_paths[name]
            self.contents[path]=(self.contents[path][0],ET.tostring(root,encoding='utf-8',xml_declaration=True))
        dest=self.path.with_suffix('.sync.xlsx')
        with zipfile.ZipFile(dest,'w') as z:
            for info,raw in self.contents.values():z.writestr(info,raw)
        dest.replace(self.path)
        return True

def item_row(ws,id):
    target=id.removeprefix('item:')
    for r in range(7,157):
        if str(ws.get(f'A{r}') or '')==target:return r
    for r in range(7,157):
        if not ws.get(f'C{r}') and not ws.get(f'A{r}'):return r
    raise ValueError('Items & Prices has no free rows (7–156)')

def material_row(ws,id):
    for r in range(7,87):
        name=str(ws.get(f'A{r}') or '').strip().lower()
        source=str(ws.get(f'L{r}') or '').strip()
        if source==id or (not source and name and 'material:'+name==id):return r
    for r in range(7,87):
        if not ws.get(f'A{r}'):return r
    raise ValueError('Materials & Prices has no free rows (7–86)')

def lookup_name_row(ws,col,name,first=11,last=260):
    name=name.strip().lower()
    for r in range(first,last+1):
        if str(ws.get(f'{col}{r}') or '').strip().lower()==name:return r
    for r in range(first,last+1):
        if not ws.get(f'{col}{r}'):return r
    raise ValueError(f'No available row in {col}{first}:{col}{last}')

def sync(path, edits):
    work=ExcelPatch(path)
    originals={name:dict(values) for name,values in work.values.items()}
    materials=originals['Materials & Prices'];items=originals['Items & Prices'];recipes=originals['Recipe Ingredients']
    buy=originals['Buying Calculator'];pawn=originals.get('Pawn Shop',{})
    # Availability columns are safe, additive fields; no existing price or recipe columns change.
    for sheet,left,right in [('Materials & Prices','M','N'),('Items & Prices','Q','R')]:
        work.set(sheet,f'{left}6','Can Sell')
        work.set(sheet,f'{right}6','Can Buy')
    new_names={}
    # Update materials first so ingredient names resolve correctly.
    for row in edits:
        e=row['edit']
        if e['type']!='material':continue
        rid=e['id'];r=material_row(work.values['Materials & Prices'],rid)
        old=str(work.get('Materials & Prices',f'A{r}') or '')
        new_names[rid]=e['name']
        if old and old.casefold()!=e['name'].casefold():
            for rr in range(7,507):
                if str(work.get('Recipe Ingredients',f'D{rr}') or '').casefold()==old.casefold():
                    work.set('Recipe Ingredients',f'D{rr}',e['name'])
        for col,value in [('A',e['name']),('C',e.get('materialCost')),('F',e.get('materialBuy')),('J',e.get('materialSell')),
                          ('K','ARCHIVED' if e.get('archived') else ''),('L',rid),
                          ('M','YES' if e.get('canSell',True) else 'NO'),('N','YES' if e.get('canBuy',True) else 'NO')]:work.set('Materials & Prices',f'{col}{r}',value)
        # Existing pawn-shop row (if an override was set) or new fallback slot.
        pawn_name=old or e['name']
        p=lookup_name_row(work.values.get('Pawn Shop',{}),'J',pawn_name,11,160)
        if e.get('shopSellOverride') is not None or work.get('Pawn Shop',f'L{p}') not in (None,''):
            work.set('Pawn Shop',f'J{p}',e['name'])
            work.set('Pawn Shop',f'L{p}',e.get('shopSellOverride'))
    # Updated ID -> material label includes unedited stock materials.
    for r in range(7,87):
        name=str(work.get('Materials & Prices',f'A{r}') or '').strip()
        if name:
            id=work.get('Materials & Prices',f'L{r}') or 'material:'+name.lower()
            new_names[id]=name
    for row in edits:
        e=row['edit'];rid=e['id']
        if e['type']!='item':continue
        r=item_row(work.values['Items & Prices'],rid)
        old=str(work.get('Items & Prices',f'C{r}') or '')
        for col,val in [('A',rid.removeprefix('item:')),('B',e['group']),('C',e['name']),
                        ('F',e.get('itemSellOverride')),('P','ARCHIVED' if e.get('archived') else ''),
                        ('Q','YES' if e.get('canSell',True) else 'NO'),('R','YES' if e.get('canBuy',True) else 'NO')]:work.set('Items & Prices',f'{col}{r}',val)
        # Ensure newly named benches also appear on the editable Bench Summary.
        bs=work.values.get('Bench Summary',{})
        if not any(str(bs.get(f'A{rr}') or '').casefold()==e['group'].casefold() for rr in range(7,37)):
            free=next((rr for rr in range(7,37) if not bs.get(f'A{rr}')),None)
            if free is not None:work.set('Bench Summary',f'A{free}',e['group'])
        # Buying calculator fixed offers/percentage inputs. Only edit matching user-input cells.
        br=lookup_name_row(work.values['Buying Calculator'],'L',old or e['name'],11,260)
        work.set('Buying Calculator',f'L{br}',e['name'])
        work.set('Buying Calculator',f'N{br}',e.get('itemBuyPercent'))
        work.set('Buying Calculator',f'O{br}',e.get('itemBuyFixed'))
        pr=lookup_name_row(work.values.get('Pawn Shop',{}),'J',old or e['name'],11,160)
        if e.get('shopSellOverride') is not None or work.get('Pawn Shop',f'L{pr}') not in (None,''):
            work.set('Pawn Shop',f'J{pr}',e['name']);work.set('Pawn Shop',f'L{pr}',e.get('shopSellOverride'))
        # Clear old recipe input cells without touching linked/formula cells.
        item_id=rid.removeprefix('item:')
        prior=[rr for rr in range(7,507) if str(work.get('Recipe Ingredients',f'A{rr}') or '')==item_id]
        for rr in prior:
            for col in ['A','D','E']:work.set('Recipe Ingredients',f'{col}{rr}','')
        for ing in e.get('ingredients',[]):
            available=next((rr for rr in prior if not work.get('Recipe Ingredients',f'A{rr}')),None)
            if available is not None:prior.remove(available)
            else:available=next((rr for rr in range(7,507) if not work.get('Recipe Ingredients',f'A{rr}') and not work.get('Recipe Ingredients',f'D{rr}')),None)
            if available is None:raise ValueError('Recipe Ingredients sheet has no space for additional recipes')
            material=new_names.get(ing['id'])
            if not material:raise ValueError(f'Material {ing["id"]} for {e["name"]} was not found')
            for col,val in [('A',item_id),('D',material),('E',ing['qty'])]:work.set('Recipe Ingredients',f'{col}{available}',val)
    return work.save()

def main():
    if len(sys.argv)!=3:raise SystemExit('Usage: python -m scripts.sync_excel source/prices.xlsx /tmp/export.json')
    payload=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    if not payload.get('ok') or not isinstance(payload.get('edits'),list):raise ValueError('Unexpected API export')
    updates=[x for x in payload['edits'] if x.get('edit')]
    result=sync(Path(sys.argv[1]),updates)
    print(f'{len(updates)} editable products applied; Excel changed: {result}')

if __name__=='__main__':main()
