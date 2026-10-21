#!/usr/bin/env python3
"""Replay the saved #391 loss cohort and compare it with a saved core report.

Reads only the frozen public benchmark report, DB, query set, annotations and source.
The DB is opened immutable/read-only. Output intentionally contains no query text,
message text, answer text, or gold source excerpts.
"""
from __future__ import annotations

import argparse, hashlib, json, math, re, sqlite3, unicodedata
from collections import Counter
from pathlib import Path

REPORT: Path
CANDIDATE_REPORT: Path
DB: Path
QUERIES: Path
BOUNDARIES: Path
GOLD: Path
SOURCE_ROOT: Path
OUT: Path
LIMIT = 8192*4

def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()

def read_json(path): return json.loads(path.read_text())
def js_slice(s,a,b):
    # Boundary coordinates are UTF-16 code units, matching JS String.slice.
    raw=s.encode('utf-16-le', 'surrogatepass')
    return raw[2*a:2*b].decode('utf-16-le', 'replace')
def terms(s):
    s=unicodedata.normalize('NFC',s).lower()
    chars=[c if c in '_-' or unicodedata.category(c)[0] in 'LN' else ' ' for c in s]
    return [x for x in ''.join(chars).split() if x]
def jsbytes(s): return len(s.encode('utf-8','replace'))

def main():
    global REPORT,CANDIDATE_REPORT,DB,QUERIES,BOUNDARIES,GOLD,SOURCE_ROOT,OUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prior-report',type=Path,required=True,help='Full report containing the frozen #391 control in message_comparison; may equal --candidate-report')
    parser.add_argument('--candidate-report',type=Path,required=True,help='Saved core-first report; this script only reads its result')
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--queries',type=Path,required=True)
    parser.add_argument('--boundaries',type=Path,required=True)
    parser.add_argument('--gold',type=Path,required=True)
    parser.add_argument('--source-root',type=Path,required=True,help='Repository source root used to verify the frozen #391 lineage')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    REPORT,CANDIDATE_REPORT,DB,QUERIES,BOUNDARIES,GOLD,SOURCE_ROOT,OUT=(args.prior_report,args.candidate_report,args.snapshot,args.queries,args.boundaries,args.gold,args.source_root,args.output)
    PACKING=SOURCE_ROOT/'benchmark/answer-quality/message-packing.ts'
    COMPARISON=SOURCE_ROOT/'benchmark/evidence-metric/message-comparison.ts'
    inputs={'prior_report':REPORT,'candidate_report':CANDIDATE_REPORT,'snapshot':DB,'queries':QUERIES,
            'boundaries':BOUNDARIES,'gold':GOLD,'message_packing_source':PACKING,'message_comparison_source':COMPARISON}
    for label,path in inputs.items():
        if not path.is_file(): raise SystemExit(f'Missing {label} input: {path}')
    if OUT.exists(): raise SystemExit(f'Refusing to overwrite analysis output: {OUT}')
    before={p:sha(p) for p in inputs.values()}
    report=read_json(REPORT)
    candidate=read_json(CANDIDATE_REPORT)
    pair=report['message_comparison']['versus_passages']
    coverage=pair['annotated_message_coverage']
    lost_ids=coverage['lost_question_ids']
    assert len(lost_ids)==29 and len(set(lost_ids))==29
    new_core=candidate['core_comparison']
    if new_core.get('strategy')!='query-message-cores-v1': raise SystemExit('Candidate report is not query-message-cores-v1')
    core_pairs={x['query_id']:x for x in new_core['versus_passages']['queries']}
    core_diagnostics={x['query_id']:x for x in new_core['queries']}
    if len(core_pairs)!=500 or len(core_diagnostics)!=500: raise SystemExit('Core report must cover all 500 queries')
    new_lost=new_core['versus_passages']['annotated_message_coverage']['lost_question_ids']
    old_lost=lost_ids
    old_set,new_set=set(old_lost),set(new_lost)
    cohort={'prior_count':len(old_lost),'recovered':[x for x in old_lost if x not in new_set],
            'still_lost':[x for x in old_lost if x in new_set],'new_losses':[x for x in new_lost if x not in old_set]}
    if len(old_lost)!=29 or len(cohort['recovered'])+len(cohort['still_lost'])!=29: raise SystemExit('Expected complete prior #391 loss-cohort classification')
    qmap={x['id']:x for x in (json.loads(l) for l in QUERIES.read_text().splitlines())}
    bdoc=read_json(BOUNDARIES); bmap={x['entry_id']:x for x in bdoc['entries']}
    gdoc=read_json(GOLD); gmap={x['query_id']:x for x in gdoc['queries']}
    rows={x['query_id']:x for x in pair['queries']}
    # immutable=1 prevents SQLite from creating or consulting WAL/journal sidecars.
    con=sqlite3.connect(f'file:{DB}?mode=ro&immutable=1',uri=True)
    con.execute('PRAGMA query_only=ON')
    get=con.cursor()

    def fetch(eid):
        row=get.execute('SELECT id,namespace,key,content,created_at,updated_at FROM entries WHERE id=?',(eid,)).fetchone()
        if not row: raise ValueError('Missing benchmark entry: '+eid)
        return dict(zip(('id','namespace','key','content','created_at','updated_at'),row))

    def validated_boundary(entry):
        b=bmap[entry['id']]
        assert b['entry_id']==entry['id']
        # Validate exact source content hash and UTF-16 span endpoints.
        assert hashlib.sha256(entry['content'].encode()).hexdigest()==b['content_sha256']
        units=len(entry['content'].encode('utf-16-le'))//2
        prev=b['prefix_end']
        assert 0<=prev<=units
        for start,content_start,end in b['messages']:
            assert prev<=start<=content_start<=end<=units
            prev=end
        return b

    def render(entries,bounds,selected):
        blocks=[]; selected_ranges=[]; indices=[]; ordered=[]
        for rank,e in enumerate(entries):
            ix=sorted(selected.get(rank,set()))
            if not ix: continue
            b=bounds[e['id']]
            ranges=[]
            if b['prefix_end']>0: ranges.append([0,b['prefix_end']])
            last=-2
            for i in ix:
                start,_,end=b['messages'][i]
                if i==last+1: ranges[-1][1]=end
                else: ranges.append([start,end])
                last=i
            label=f"{e['namespace']}/{e['key']}" if e['key'] else e['namespace']
            header=f"[{len(blocks)+1}] {label} ({e['updated_at'] or e['created_at']})"
            body='\n'.join(f'[source utf16 {a}:{z}]\n{js_slice(e["content"],a,z)}' for a,z in ranges)
            blocks.append(header+'\n'+body)
            ordered.append(e['id']); indices.append({'entry_id':e['id'],'message_indices':ix})
            selected_ranges.extend({'entry_id':e['id'],'start':a,'end':z} for a,z in ranges)
        text='\n\n'.join(blocks)
        return text,selected_ranges,indices,ordered

    output=[]
    for qid in lost_ids:
        r=rows[qid]; q=qmap[qid]; gold=gmap[qid]
        assert r['annotated_messages']['eligible'] and r['annotated_messages']['reference_all_turns'] is True and r['annotated_messages']['candidate_all_turns'] is False
        assert q['expected_ids']==r['expected_ids']
        entries=[fetch(eid) for eid in r['retrieved_ids']]
        bounds={e['id']:validated_boundary(e) for e in entries}
        gold_entries={x['entry_id']:x for x in gold['entries']}
        lost_turns=r['annotated_messages']['lost_turns']
        assert lost_turns
        # Replay exactly the label-free scored anchor order and transactional bundle admission.
        qt=set(terms(q['query']))
        anchors=[]
        for rank,e in enumerate(entries):
            b=bounds[e['id']]
            for mi,(_,cs,end) in enumerate(b['messages']):
                ts=set(terms(js_slice(e['content'],cs,end)))
                overlap=len(ts & qt)
                anchors.append({'rank':rank,'message_index':mi,'score':overlap/math.sqrt(max(1,len(ts))),'overlap':overlap,'term_count':len(ts)})
        anchors.sort(key=lambda a:(-a['score'],a['rank'],a['message_index']))
        selected={}; replay_events=[]
        for arank,a in enumerate(anchors,1):
            rank,mi=a['rank'],a['message_index']; old=selected.get(rank,set())
            proposed=set(old); n=len(bounds[entries[rank]['id']]['messages'])
            bundle=set(range(max(0,mi-1),min(n-1,mi+1)+1)); proposed.update(bundle)
            if len(proposed)==len(old): continue
            selected[rank]=proposed
            text,_,_,_=render(entries,bounds,selected)
            full_bytes=jsbytes(text)
            if full_bytes<=LIMIT:
                replay_events.append({'anchor_rank':arank,'entry_rank':rank+1,'message_index':mi,'score':a['score'],'overlap':a['overlap'],'term_count':a['term_count'],'bundle_indices':sorted(bundle),'decision':'admitted','rendered_bytes':full_bytes,'added_message_count':len(proposed-old)})
            else:
                selected[rank]=old
                prior_bytes=jsbytes(render(entries,bounds,selected)[0])
                single=set(old); single.add(mi)
                solo_state=dict(selected); solo_state[rank]=single
                solo_bytes=jsbytes(render(entries,bounds,solo_state)[0])
                # Evaluate bundle increment over the same pre-attempt state.
                prior=dict(selected); prior[rank]=old
                bundle_state=dict(prior); bundle_state[rank]=proposed
                bundle_bytes=jsbytes(render(entries,bounds,bundle_state)[0])
                replay_events.append({'anchor_rank':arank,'entry_rank':rank+1,'message_index':mi,'score':a['score'],'overlap':a['overlap'],'term_count':a['term_count'],'bundle_indices':sorted(bundle),'decision':'rejected_budget','rendered_bytes':bundle_bytes,'prior_rendered_bytes':prior_bytes,'incremental_bundle_bytes':bundle_bytes-prior_bytes,'single_anchor_bytes':solo_bytes,'added_message_count':len(proposed-old)})
        # Replay must exactly reproduce output stored in immutable report.
        text, ranges, selected_ix, selected_ids=render(entries,bounds,selected)
        assert selected_ix==r['selected_message_indices'] if 'selected_message_indices' in r else True
        assert selected_ids==r['candidate_packed_ids'], (qid,selected_ids,r['candidate_packed_ids'])
        # Source ranges reported by message-packing.ts must match byte-for-byte.
        assert ranges==r['candidate_ranges'], (qid,ranges[:2],r['candidate_ranges'][:2])
        assert math.ceil(jsbytes(text)/4)==r['candidate_budget']['estimated_tokens']
        selected_by_id={x['entry_id']:set(x['message_indices']) for x in selected_ix}
        candidate_range_by_id={eid:[x for x in ranges if x['entry_id']==eid] for eid in {x['entry_id'] for x in ranges}}
        lost_detail=[]
        for t in lost_turns:
            eid=t['entry_id']; mi=t['message_index']; e=next(x for x in entries if x['id']==eid); b=bounds[eid]
            start,content_start,end=b['messages'][mi]
            raw=js_slice(e['content'],start,end)
            qterms=set(terms(q['query'])); mterms=set(terms(js_slice(e['content'],content_start,end)))
            overlap=len(qterms&mterms); score=overlap/math.sqrt(max(1,len(mterms)))
            ranking=next(i for i,a in enumerate(anchors,1) if a['rank']==r['retrieved_ids'].index(eid) and a['message_index']==mi)
            present_other=sorted(selected_by_id.get(eid,set()))
            rejection=next((ev for ev in replay_events if ev['entry_rank']==r['retrieved_ids'].index(eid)+1 and ev['message_index']==mi and ev['decision']=='rejected_budget'),None)
            # A gold message can enter as a neighbor of another anchor. Identify all admitted bundles touching it.
            admitted_by=[ev for ev in replay_events if ev['decision']=='admitted' and ev['entry_rank']==r['retrieved_ids'].index(eid)+1 and mi in ev['bundle_indices']]
            covered=mi in selected_by_id.get(eid,set())
            lost_detail.append({
                'entry_id':eid,'gold_message_index':mi,'gold_range_utf16':[start,end],
                'gold_message_utf8_bytes':jsbytes(raw),'entry_rank':r['retrieved_ids'].index(eid)+1,
                'message_count_in_entry':len(b['messages']),'entry_utf8_bytes':jsbytes(e['content']),
                'prefix_utf16_units':b['prefix_end'],'prefix_utf8_bytes':jsbytes(js_slice(e['content'],0,b['prefix_end'])),
                'query_overlap_term_count':overlap,'message_unique_term_count':len(mterms),'anchor_score':score,'anchor_rank':ranking,
                'selected_entry_elsewhere':bool(present_other),'selected_message_indices_in_entry':present_other,
                'gold_message_selected':covered,
                'gold_turn_entry_is_retrieved':True,
                'gold_anchor_rejection':None if not rejection else {k:rejection[k] for k in ['anchor_rank','prior_rendered_bytes','rendered_bytes','incremental_bundle_bytes','single_anchor_bytes','added_message_count']},
                'admitted_neighbor_bundles_touching_gold':len(admitted_by),
                'nearest_admitted_neighbors':sorted({j for ev in admitted_by for j in ev['bundle_indices'] if j!=mi}),
                'gold_message_utf8_bytes_with_header_overhead':None,
            })
        core_pair=core_pairs[qid]
        core_diag=core_diagnostics[qid]
        assert core_pair['retrieved_ids']==r['retrieved_ids'] and core_pair['expected_ids']==r['expected_ids']
        core_selected={x['entry_id']:set(x['message_indices']) for x in core_diag['selected_message_indices']}
        core_selected_by_rank={rank:core_selected.get(e['id'],set()) for rank,e in enumerate(entries)}
        core_text,core_ranges,_,core_ordered_ids=render(entries,bounds,core_selected_by_rank)
        core_bytes=jsbytes(core_text)
        assert core_ranges==core_diag['candidate_ranges']==core_pair['candidate_ranges']
        assert core_ordered_ids==core_pair['candidate_packed_ids']
        assert core_diag['candidate_budget']==core_pair['candidate_budget']
        assert math.ceil(core_bytes/4)==core_diag['candidate_budget']['estimated_tokens']
        core_recovered=[x for x in lost_detail if x['gold_message_index'] in core_selected.get(x['entry_id'],set())]
        core_missed=[x for x in lost_detail if x['gold_message_index'] not in core_selected.get(x['entry_id'],set())]
        core_case={
            'candidate_all_annotated_turns':core_pair['annotated_messages']['candidate_all_turns'],
            'candidate_selected_message_count':sum(len(v) for v in core_selected.values()),
            'candidate_context_bytes':core_bytes,
            'candidate_estimated_tokens':core_diag['candidate_budget']['estimated_tokens'],
            'candidate_budget_headroom_bytes':LIMIT-core_bytes,
            'old_lost_gold_messages_recovered_by_core_count':len(core_recovered),
            'old_lost_gold_messages_still_missing_count':len(core_missed),
            'old_lost_gold_messages_recovered_by_core':[{'entry_id':x['entry_id'],'message_index':x['gold_message_index']} for x in core_recovered],
            'old_lost_gold_messages_still_missing':[{'entry_id':x['entry_id'],'message_index':x['gold_message_index']} for x in core_missed],
        }
        # Summarize actual budget footprint without content: exact rendered bytes by entry and selected messages.
        selected_message_bytes=0; admitted_neighbor_bytes=0; neighbor_message_count=0
        for ent in selected_ix:
            e=next(x for x in entries if x['id']==ent['entry_id']); b=bounds[e['id']]
            for mi in ent['message_indices']:
                s,_,z=b['messages'][mi]; mb=jsbytes(js_slice(e['content'],s,z)); selected_message_bytes+=mb
                if not any(t['entry_id']==e['id'] and t['message_index']==mi for t in lost_turns):
                    # Neighbor-only means no admitted anchor at this message index itself.
                    if not any(ev['decision']=='admitted' and ev['entry_rank']==r['retrieved_ids'].index(e['id'])+1 and ev['message_index']==mi for ev in replay_events):
                        admitted_neighbor_bytes+=mb; neighbor_message_count+=1
        # Budget decision totals and long gold message counts use UTF-8 payload bytes (headers/ranges separately reflected in total context).
        rej=[e for e in replay_events if e['decision']=='rejected_budget']
        output.append({
            'query_id':qid,'category':r['category'],'lost_gold_message_count':len(lost_turns),
            'retrieved_entry_count':len(entries),'selected_entry_count':len(selected_ids),
            'candidate_context_bytes':jsbytes(text),'budget_bytes':LIMIT,'budget_headroom_bytes':LIMIT-jsbytes(text),
            'candidate_estimated_tokens':math.ceil(jsbytes(text)/4),'reference_estimated_tokens':r['reference_budget']['estimated_tokens'],
            'retrieved_entry_ranks':{eid:i+1 for i,eid in enumerate(r['retrieved_ids'])},
            'lost_gold_messages':lost_detail,
            'core_first':core_case,
            'selected_message_count':sum(len(x['message_indices']) for x in selected_ix),
            'selected_message_payload_bytes':selected_message_bytes,
            'admitted_neighbor_only_message_count':neighbor_message_count,
            'admitted_neighbor_only_payload_bytes':admitted_neighbor_bytes,
            'budget_rejected_bundle_count':len(rej),
            'budget_rejected_bundle_payload_increment_bytes':sum(e['incremental_bundle_bytes'] for e in rej),
            'gold_lost_due_to_budget_rejection_count':sum(x['gold_anchor_rejection'] is not None for x in lost_detail),
            'all_gold_messages_whole_fit_as_single_anchor_at_rejection':all(x['gold_anchor_rejection'] and x['gold_anchor_rejection']['single_anchor_bytes']<=LIMIT for x in lost_detail),
            'long_gold_messages_4k_plus':sum(x['gold_message_utf8_bytes']>=4096 for x in lost_detail),
            'long_gold_messages_8k_plus':sum(x['gold_message_utf8_bytes']>=8192 for x in lost_detail),
        })

    # Validate reproduction of reported lost IDs and source immutability.
    assert [x['query_id'] for x in output]==lost_ids
    con.close()
    after={p:sha(p) for p in inputs.values()}
    assert before==after, 'An input changed while analysis ran'
    cats=Counter(x['category'] for x in output)
    totals={
        'regression_question_count':len(output),
        'lost_gold_message_count':sum(x['lost_gold_message_count'] for x in output),
        'budget_rejected_bundle_count':sum(x['budget_rejected_bundle_count'] for x in output),
        'lost_messages_with_budget_rejection_at_their_own_anchor':sum(x['gold_lost_due_to_budget_rejection_count'] for x in output),
        'lost_messages_selected_entry_elsewhere':sum(m['selected_entry_elsewhere'] for x in output for m in x['lost_gold_messages']),
        'lost_messages_whole_fit_single_anchor_on_rejection':sum(bool(m['gold_anchor_rejection'] and m['gold_anchor_rejection']['single_anchor_bytes']<=LIMIT) for x in output for m in x['lost_gold_messages']),
        'long_lost_messages_4k_plus':sum(x['long_gold_messages_4k_plus'] for x in output),
        'long_lost_messages_8k_plus':sum(x['long_gold_messages_8k_plus'] for x in output),
        'admitted_neighbor_only_messages':sum(x['admitted_neighbor_only_message_count'] for x in output),
        'admitted_neighbor_only_payload_bytes':sum(x['admitted_neighbor_only_payload_bytes'] for x in output),
        'budget_rejected_bundle_payload_increment_bytes':sum(x['budget_rejected_bundle_payload_increment_bytes'] for x in output),
        'categories':dict(sorted(cats.items())),
    }
    logical_hashes={name:before[path] for name,path in inputs.items()}
    doc={'schema_version':1,'analysis':'PR391 loss cohort replay and core-first comparison','metric':'full_original_annotated_message_coverage_v1',
         'prior_policy_control':{'report_sha256':before[REPORT],'report_section':'message_comparison','reference_pair':'versus_passages','strategy':report['message_comparison']['strategy']},
         'prior_mechanism':{'anchor_score':'unique query-term overlap / sqrt(max(1, unique message terms))','bundle':'anchor plus immediate predecessor/successor','admission':'whole rendered state must fit; failed bundle is rolled back'},
         'reproducibility':{'input_sha256':logical_hashes,'db_mode':'mode=ro,immutable=1; PRAGMA query_only=ON',
             'input_hashes_unchanged_after_run':True,'prior_report_replay_assertions':'candidate ordered IDs, UTF-16 ranges, estimated tokens; all 29 lost IDs'},
         'prior_391_loss_cohort_29':cohort,'prior_391_totals':totals,'cases':output}
    OUT.parent.mkdir(parents=True,exist_ok=True)
    with OUT.open('x',encoding='utf-8') as f: json.dump(doc,f,indent=2,sort_keys=True); f.write('\n')
    print(json.dumps({'output':str(OUT),'prior_policy_control':doc['prior_policy_control'],'prior_391_totals':totals,'prior_391_loss_cohort_29':cohort},sort_keys=True))

if __name__=='__main__': main()
