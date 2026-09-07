import importlib.util,pathlib,tempfile,subprocess,sys,unittest,threading,time,json,os
REPO=pathlib.Path(__file__).resolve().parents[1]
WRAPPER=REPO/'scripts/survival-matrix.py'
spec=importlib.util.spec_from_file_location('wrapper',WRAPPER);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
temporary=tempfile.TemporaryDirectory(prefix='atlas-v3-wrapper-controls-')
root=pathlib.Path(temporary.name)
@unittest.skipUnless(sys.platform=='linux' and hasattr(os,'waitid'), 'Owned process-group controls require Linux waitid/WNOWAIT and /proc.')
class Control(unittest.TestCase):
 @classmethod
 def tearDownClass(cls): temporary.cleanup()
 def test_success_and_nonzero(self):
  ok=m.run_managed([sys.executable,'-c','print("synthetic")'],root,root/'ok.log',5,1024,threading.Event());self.assertEqual(ok['exitCode'],0);self.assertIsNone(ok['failure'])
  bad=m.run_managed([sys.executable,'-c','raise SystemExit(3)'],root,root/'bad.log',5,1024,threading.Event());self.assertEqual(bad['exitCode'],3)
 def test_log_quota(self):
  r=m.run_managed([sys.executable,'-c','import os;os.write(1,b"x"*1000000)'],root,root/'log-quota.log',5,1024,threading.Event());self.assertEqual(r['failure'],'log-quota');self.assertEqual((root/'log-quota.log').stat().st_size,1024)
 def test_timeout_child_group_and_unrelated_process(self):
  unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
  try:
   childfile=root/'owned-child.json'
   source='import subprocess,sys,time,json,pathlib,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=subprocess.Popen([sys.executable,"-c","import time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"]);pathlib.Path(sys.argv[1]).write_text(json.dumps({"pid":p.pid}));time.sleep(30)'
   r=m.run_managed([sys.executable,'-c',source,str(childfile)],root,root/'timeout.log',1,1024,threading.Event());self.assertEqual(r['failure'],'wall-time-quota');self.assertIsNone(unrelated.poll())
   pid=json.loads(childfile.read_text())['pid'];stat=pathlib.Path(f'/proc/{pid}/stat');self.assertTrue(not stat.exists() or stat.read_text().split(') ')[1].startswith('Z'))
  finally:unrelated.terminate();unrelated.wait(timeout=5)
 def test_owner_stop(self):
  stop=threading.Event();timer=threading.Timer(.2,stop.set);timer.start()
  try:r=m.run_managed([sys.executable,'-c','import time;time.sleep(30)'],root,root/'stop.log',5,1024,stop);self.assertEqual(r['failure'],'owner-stop-requested')
  finally:timer.join()
 def test_plan_and_bad_pin_no_output(self):
  source=REPO;sha=m.head(source);out=root/'should-not-exist'
  p=subprocess.run([sys.executable,str(WRAPPER),source,str(out),'--source-sha',sha],capture_output=True,text=True,timeout=10);self.assertEqual(p.returncode,0);self.assertEqual(json.loads(p.stdout)['status'],'plan-only');self.assertFalse(out.exists())
  p=subprocess.run([sys.executable,str(WRAPPER),source,str(out),'--source-sha','0'*40],capture_output=True,text=True,timeout=10);self.assertNotEqual(p.returncode,0);self.assertFalse(out.exists())
if __name__=='__main__':unittest.main()
