// Every test file starts on a Mac (the jsdom user agent names the OS the tests run on); a test of another platform sets it
// with setPlatform and puts it back.
import { setPlatform } from '../src/platform';

setPlatform('mac', false);
