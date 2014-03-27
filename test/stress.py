#! /bin/env python

import argparse
import cookielib
import mechanize
from multiprocessing import Pool
import random
import string
import time

parser = argparse.ArgumentParser()
parser.add_argument('target')
args = parser.parse_args()

RANDOM_LENGTH = 32
TEST_AMOUNT = 2048
POOL_SIZE = 64

def get_random_string():
  return ''.join(random.choice(string.digits)
      for x in range(RANDOM_LENGTH))

def get_browser():
  browser = mechanize.Browser()
  browser.set_cookiejar(cookielib.LWPCookieJar())
  browser.set_handle_equiv(True)
  browser.set_handle_redirect(True)
  browser.set_handle_referer(True)
  browser.set_handle_robots(False)
  browser.set_handle_refresh(mechanize._http.HTTPRefreshProcessor(), max_time=1)
  browser.addheaders = [('User-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33.0.1750.146 Safari/537.36')]
  return browser

def run_game(i):
  p1 = None
  p2 = None
  try:
    p1 = get_browser()
    p1.open(args.target)
    p1.follow_link(url_regex='/create/')
    p1.select_form(nr=0)
    passphrase = get_random_string()
    p1['passphrase'] = passphrase
    p1.submit()

    p1.select_form(nr=0)
    p1['name'] = get_random_string()
    response = p1.submit()
    
    p2 = get_browser()
    p2.open(args.target)
    p2.follow_link(url_regex='/join/')
    p2.select_form(nr=0)
    p2['passphrase'] = passphrase
    p2.submit()

    p2.select_form(nr=0)
    p2['name'] = get_random_string()
    p2.submit()
    
    started = False
    lobby_url = response.geturl()
    p1 = get_browser()
    p1.open(lobby_url)
    while not started:
      try:
        p1.select_form(nr=0)
        p1.submit(name='action_start')
        started = True
      except mechanize.ControlNotFoundError:
        print '--- TEST #{} Reload ---'.format(i)
        time.sleep(1)
        p1 = get_browser()
        p1.open(lobby_url)
    p1.select_form(nr=1)
    p1.submit(name='action_finish')
    print '** TEST #{} **'.format(i)
    return True
  except Exception as e:
    print p1
    print p2
    print type(e)
    print e
    print '** TEST #{} FAIL **'.format(i)
    return False

if __name__ == '__main__':

  run_game(1)
  pool = Pool(processes=POOL_SIZE)
  results = pool.map(run_game, range(TEST_AMOUNT))
  passed_count = len(filter(lambda x: x, results))
  print '\nRESULTS: {} pass, {} fail'.format(passed_count, TEST_AMOUNT-passed_count)