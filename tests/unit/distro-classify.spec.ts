import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLinuxDistro } from '../../src/commands/onboard.js';

/**
 * Real /etc/os-release excerpts. The classification used to be untestable —
 * it read the file itself — so the only coverage was a test that passed an
 * already-classified distro straight to installInstructions(). That test
 * stayed green while the detector sent RHEL down the Fedora path.
 */
const OS_RELEASE: Record<string, string> = {
  fedora: 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=40\n',
  rhel: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\nVERSION_ID="9.4"\n',
  centos: 'NAME="CentOS Stream"\nID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="9"\n',
  rocky: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n',
  alma: 'NAME="AlmaLinux"\nID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n',
  amazon2023: 'NAME="Amazon Linux"\nID="amzn"\nID_LIKE="fedora"\nVERSION_ID="2023"\n',
  amazon2: 'NAME="Amazon Linux"\nID="amzn"\nID_LIKE="centos rhel fedora"\nVERSION_ID="2"\n',
  ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n',
  debian: 'NAME="Debian GNU/Linux"\nID=debian\nVERSION_ID="12"\n',
  mint: 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
  pop: 'NAME="Pop!_OS"\nID=pop\nID_LIKE="ubuntu debian"\n',
  opensuse: 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
  arch: 'NAME="Arch Linux"\nID=arch\n',
  alpine: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.0\n',
};

describe('classifyLinuxDistro', () => {
  test('Debian and its derivatives use apt', () => {
    for (const key of ['ubuntu', 'debian', 'mint', 'pop']) {
      assert.equal(classifyLinuxDistro(OS_RELEASE[key], false), 'debian', key);
    }
  });

  test('Fedora is matched on its own ID, not on being fedora-like', () => {
    assert.equal(classifyLinuxDistro(OS_RELEASE.fedora, true), 'fedora');
    // Every RHEL-like below declares ID_LIKE=fedora; none of them is Fedora, and
    // none of them carries Fedora's `moby-engine` package.
    for (const key of ['rhel', 'centos', 'rocky', 'alma']) {
      assert.equal(classifyLinuxDistro(OS_RELEASE[key], true), 'rhel', key);
    }
  });

  // Amazon Linux 2 declares itself RHEL-like but ships yum, not dnf. Trusting
  // the declaration hands it `sudo dnf install -y podman` and a
  // "dnf: command not found" after the wizard called the platform supported.
  test('a RHEL-like without dnf falls back to manual instructions', () => {
    assert.equal(classifyLinuxDistro(OS_RELEASE.amazon2, false), 'unknown');
    assert.equal(classifyLinuxDistro(OS_RELEASE.amazon2023, true), 'rhel');
    assert.equal(classifyLinuxDistro(OS_RELEASE.rhel, false), 'unknown');
  });

  test('distributions with neither package manager are unknown, not guessed at', () => {
    for (const key of ['opensuse', 'arch', 'alpine']) {
      assert.equal(classifyLinuxDistro(OS_RELEASE[key], true), 'unknown', key);
    }
  });

  test('an unreadable or empty os-release is unknown', () => {
    assert.equal(classifyLinuxDistro('', true), 'unknown');
  });
});
