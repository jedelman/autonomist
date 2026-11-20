import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAddress, shownOwner, lookupParcel } from '../worker/parcel.js'

test('parses addresses and refuses anything else', () => {
  assert.deepEqual(parseAddress('740 W Princess Anne Rd, Norfolk, VA'), { number: '740', name: 'PRINCESS ANNE' })
  assert.deepEqual(parseAddress('2811 Colonial Avenue'), { number: '2811', name: 'COLONIAL' })
  assert.equal(parseAddress('Jane Smith'), null)
  assert.equal(parseAddress("1 Main St' OR 1=1 --")?.name, 'MAIN ST OR 1 1')
})

test('never shows the owner of a home or an individual', () => {
  assert.equal(shownOwner('Example Holdings, LLC', '403 Apartment 12-48').owner, 'Example Holdings, LLC')
  assert.equal(shownOwner('Example Holdings, LLC', '513 Single Family').owner, null)
  assert.equal(shownOwner('Jane Smith', '401 Apartment 5-11').owner, null)
  assert.equal(shownOwner('Smith Family Revocable Trust LLC', '401 Apartment 5-11').owner, null)
})

test('a home comes back without owner or sale price', async () => {
  const fetchJson = async (url) => url.includes('qva7-tzrf') ? [{ parcel_id: '1', gpin: '123', owner: 'Jane Smith', property_street_number: '10', property_street_name: 'Main', property_class_description: '513 Single Family', current_total_value: '300000', transfer_date: '2020-01-01T00:00:00.000', consideration: '250000' }] : []
  const r = await lookupParcel('10 Main St', fetchJson)
  assert.equal(r.owner, null)
  assert.equal(r.last_transfer, undefined)
  assert.ok(!JSON.stringify(r).includes('Jane'))
})
