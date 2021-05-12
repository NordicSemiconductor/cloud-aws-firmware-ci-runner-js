import { CommandDefinition } from './CommandDefinition'
import {
	atHostHexfile,
	download,
} from '@nordicsemiconductor/firmware-ci-device-helpers'
import { runJob } from '../../runner/runJob'
import { promises as fs } from 'fs'

export const runFromFileCommand = (): CommandDefinition => ({
	command: 'run-once <device> <jobFile>',
	options: [
		{
			flags: '-t, --thingy',
			description: `Connected DK is a thingy`,
		},
	],
	action: async (device, jobFile, { thingy }) => {
		const doc = JSON.parse(await fs.readFile(jobFile, 'utf-8'))
		const hexfile = await download({
			fw: doc.fw,
			target: `${doc.id}.hex`,
		})
		await runJob({
			doc,
			hexfile,
			device,
			atHostHexfile:
				thingy === true ? atHostHexfile.thingy91 : atHostHexfile['9160dk'],
		})
		await fs.unlink(hexfile)
	},
	help: 'Execute one firmware CI job from a file',
})
