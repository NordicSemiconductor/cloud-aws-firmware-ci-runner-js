import { CommandDefinition } from './CommandDefinition'
import { runner } from '../../runner/runner'
import { atHostHexfile } from '@nordicsemiconductor/firmware-ci-device-helpers'
import * as chalk from 'chalk'

const defaultPowerCycleWaitSeconds = 10
const defaultPowerCycleWaitAfterOnSeconds = 5

export const runCommand = (): CommandDefinition => ({
	command: 'run <device> <certificateJSON>',
	options: [
		{
			flags: '-t, --thingy',
			description: `Connected DK is a thingy`,
		},
		{
			flags: '-poff, --power-cycle-off <cmd>',
			description: 'Turn off device before running the job using <cmd>.',
		},
		{
			flags: '-pon, --power-cycle-on <cmd>',
			description: 'Turn on device before running the job using <cmd>.',
		},
		{
			flags: '-w, --power-cycle-wait <seconds>',
			description: `Turn off device for this amount of seconds during power cycle. Defaults to ${defaultPowerCycleWaitSeconds} seconds.`,
		},
		{
			flags: '-wafter, --power-cycle-wait-after-on <seconds>',
			description: `Wait for this amount of seconds after turning on the device. Defaults to ${defaultPowerCycleWaitAfterOnSeconds} seconds.`,
		},
	],
	action: async (
		device,
		certificateJSON,
		{
			thingy,
			powerCycleOff,
			powerCycleOn,
			powerCycleWait,
			powerCycleWaitAfterOn,
		},
	) => {
		const waitSeconds = parseInt(
			powerCycleWait ?? `${defaultPowerCycleWaitSeconds}`,
			10,
		)
		const waitSecondsAfterOn = parseInt(
			powerCycleWaitAfterOn ?? `${defaultPowerCycleWaitAfterOnSeconds}`,
			10,
		)
		if (powerCycleOff !== undefined && powerCycleOn !== undefined) {
			console.debug('')
			console.debug(chalk.gray(`Will power cycle device before each run:`))
			console.debug(chalk.red(' Off ', chalk.blue(powerCycleOff)))
			console.debug(chalk.yellow(' Wait', chalk.blue(`${waitSeconds} seconds`)))
			console.debug(chalk.green(' On  ', chalk.blue(powerCycleOn)))
			console.debug(
				chalk.yellow(' Wait', chalk.blue(`${waitSecondsAfterOn} seconds`)),
			)
			console.debug('')
		}
		await runner({
			certificateJSON,
			atHostHexfile:
				thingy === true ? atHostHexfile.thingy91 : atHostHexfile['9160dk'],
			device,
			powerCycle:
				powerCycleOff !== undefined && powerCycleOn !== undefined
					? {
							offCmd: powerCycleOff,
							onCmd: powerCycleOn,
							waitSeconds,
							waitSecondsAfterOn,
					  }
					: undefined,
		})
	},
	help: 'Execute firmware CI jobs',
})
