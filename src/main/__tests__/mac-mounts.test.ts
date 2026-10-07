import { describe, expect, it } from 'vitest'
import { hasMountAt, parseWebdavMount } from '../mac-mounts'

const MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  'https://app.mapli.fr/Mapli/ on /Volumes/Mapli (webdav, nodev, noexec, nosuid, mounted by nicolas)',
  'https://autre.exemple.fr/dav/ on /Volumes/Autre 1 (webdav, nodev, noexec, nosuid, mounted by nicolas)'
].join('\n')

describe('parseWebdavMount', () => {
  it('retrouve le volume par son adresse', () => {
    expect(parseWebdavMount(MOUNT, 'https://app.mapli.fr/Mapli/')).toBe('/Volumes/Mapli')
  })

  it("ignore la barre finale et la casse de l'hôte", () => {
    expect(parseWebdavMount(MOUNT, 'https://APP.mapli.fr/Mapli')).toBe('/Volumes/Mapli')
  })

  it('garde les espaces du point de montage', () => {
    expect(parseWebdavMount(MOUNT, 'https://autre.exemple.fr/dav')).toBe('/Volumes/Autre 1')
  })

  it("renvoie null quand l'adresse n'est pas montée", () => {
    expect(parseWebdavMount(MOUNT, 'https://app.mapli.fr/dav/')).toBeNull()
    expect(parseWebdavMount('', 'https://app.mapli.fr/Mapli/')).toBeNull()
  })

  it("ne confond pas un volume d'un autre type", () => {
    const smb =
      '//nicolas@nas/partage on /Volumes/partage (smbfs, nodev, nosuid, mounted by nicolas)'
    expect(parseWebdavMount(smb, '//nicolas@nas/partage')).toBeNull()
  })
})

describe('hasMountAt', () => {
  const table = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    'localhost:/ on /Users/julie/Library/Application Support/mapli-drive/Mapli (nfs, nodev, nosuid, mounted by julie)',
    'https://app.mapli.fr/Mapli/ on /Volumes/Mapli (webdav, nodev, noexec, nosuid, mounted by julie)'
  ].join('\n')
  const nfsPoint = '/Users/julie/Library/Application Support/mapli-drive/Mapli'

  it('reconnaît le lecteur NFS par son dossier (espaces compris)', () => {
    expect(hasMountAt(table, nfsPoint, 'nfs')).toBe(true)
    expect(hasMountAt(table, `${nfsPoint}/`, 'nfs')).toBe(true)
  })

  it('distingue le type de volume', () => {
    expect(hasMountAt(table, nfsPoint, 'webdav')).toBe(false)
    expect(hasMountAt(table, '/Volumes/Mapli', 'webdav')).toBe(true)
    expect(hasMountAt(table, '/Volumes/Mapli', 'nfs')).toBe(false)
  })

  it('ne confond pas un dossier voisin', () => {
    expect(hasMountAt(table, '/Users/julie/Library/Application Support/mapli-drive', 'nfs')).toBe(
      false
    )
    expect(hasMountAt('', nfsPoint, 'nfs')).toBe(false)
  })
})
